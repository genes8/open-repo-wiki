// Mock OpenAI-compatible server for testing the repo-wiki pipeline offline.
// Returns a plan JSON for the planning prompt, markdown for page prompts.
// Usage: node test/mock-llm.js  (listens on http://127.0.0.1:8688/v1)
//        MOCK_DELAY_MS=1000 node test/mock-llm.js   # simulate slow model
const http = require('http');
const DELAY = parseInt(process.env.MOCK_DELAY_MS, 10) || 0;

const PLAN = JSON.stringify({
  pages: [
    { path: 'overview.md', title: 'Project Overview', description: 'What the project does', files: ['README.md', 'package.json'] },
    { path: 'architecture/core.md', title: 'Core Architecture', description: 'Main module', files: ['generate.js', 'lib/scan.js', 'src/DOES-NOT-EXIST.js'] },
    { path: 'guides/guides.md', title: 'Guides', description: 'Section landing page', files: ['README.md'] },
    { path: 'guides/getting-started.md', title: 'Getting Started', description: 'Install and run', files: ['README.md', 'package.json'] },
    { path: 'guides/configuration.md', title: 'Configuration', description: 'Config options', files: ['config.json'] },
  ],
});

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404); res.end('not found'); return;
    }
    const payload = JSON.parse(body);
    const systemMsg = payload.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const userMsg = payload.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    // Classify by the SYSTEM prompt only — it is set by the prompt builders and is
    // never contaminated by echoed source-file contents. (User messages carry
    // attached file bodies, some of which contain the planning marker string and
    // would otherwise misroute page/knowledge requests to the plan branch.)
    let content;
    if (/documentation wiki/i.test(systemMsg)) {
      content = 'Here is the plan:\n```json\n' + PLAN + '\n```';
    } else if (/knowledge card/i.test(systemMsg)) {
      const cardMatch = userMsg.match(/Card focus:\s*(.+)/);
      const modMatch = userMsg.match(/Module: "([^"]+)"/);
      const card = cardMatch ? cardMatch[1].trim() : 'card';
      const mod = modMatch ? modMatch[1] : 'module';
      content = `Knowledge card for module \`${mod}\`.\n\nFocus: ${card}\n\nThis card is grounded in the module's attached source files.\n`;
    } else {
      const m = userMsg.match(/Write the wiki page "([^"]+)"/);
      const title = m ? m[1] : 'Page';
      // Faithfully mirror the prompt: the standard template injects a <cite> block
      // (carrying the TOC + Section/Diagram sources instructions); the minimal
      // template omits it. Gate our structured output on that same signal so the
      // mock reflects whether the minimal template is actually honored, instead of
      // emitting a TOC unconditionally.
      const cite = userMsg.match(/<cite>[\s\S]*?<\/cite>/);
      if (cite) {
        const srcLines = cite[0].split('\n').filter(l => /^\s*- \[/.test(l)).join('\n');
        const sources = srcLines ? `\n**Section sources**\n${srcLines}\n` : '';
        const diagramSources = srcLines ? `\n**Diagram sources**\n${srcLines}\n` : '';
        content =
          `# ${title}\n\n${cite[0]}\n\n` +
          `## Table of Contents\n1. [Overview](#overview)\n2. [Details](#details)\n\n` +
          `## Overview\n\nThis page documents the repository based on the attached sources.\n${sources}\n` +
          `## Details\n\n\`\`\`mermaid\ngraph TD\n  A[Repo] --> B[Wiki]\n\`\`\`\n${diagramSources}\n` +
          `More detail grounded in the shown code.\n`;
      } else {
        // Minimal template (or no attached files): no cite, no TOC, no sources.
        content =
          `# ${title}\n\n` +
          `This page documents the repository based on the attached sources.\n\n` +
          `\`\`\`mermaid
graph TD
  A[Repo] --> B[Wiki]
\`\`\`
`;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    setTimeout(() => res.end(reply), DELAY);
  });
});
server.listen(8688, '127.0.0.1', () => console.log('mock LLM on http://127.0.0.1:8688/v1'));
