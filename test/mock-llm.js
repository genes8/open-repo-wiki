'use strict';

// Importable OpenAI-compatible mock for deterministic offline integration tests.
// Direct usage remains supported:
//   node test/mock-llm.js
//   MOCK_PORT=8688 MOCK_DELAY_MS=1000 node test/mock-llm.js

const http = require('http');

const DEFAULT_PLAN = {
  pages: [
    {
      path: 'overview.md',
      title: 'Project Overview',
      description: 'What the project does',
      files: ['README.md', 'package.json'],
    },
    {
      path: 'architecture/core.md',
      title: 'Core Architecture',
      description: 'Main module',
      files: ['generate.js', 'lib/scan.js', 'src/DOES-NOT-EXIST.js'],
    },
    {
      path: 'guides/guides.md',
      title: 'Guides',
      description: 'Section landing page',
      files: ['README.md'],
    },
    {
      path: 'guides/getting-started.md',
      title: 'Getting Started',
      description: 'Install and run',
      files: ['README.md', 'package.json'],
    },
    {
      path: 'guides/configuration.md',
      title: 'Configuration',
      description: 'Config options',
      files: ['config.json'],
    },
  ],
};

function extractTitle(userMessage) {
  // Matches both the authoring prompt ('Write the wiki page "X"') and the
  // minimal-edit repair prompt ('The draft below for the wiki page "X" ...').
  const match = userMessage.match(/wiki page "([^"]+)"/);
  return match ? match[1] : 'Page';
}

function extractChildLinks(userMessage) {
  const block = userMessage.match(
    /(?:Include every child using these exact links|Keep these exact child links):\n((?:- \[[^\n]+\]\([^)]+\)\n?)+)/
  );
  return block ? block[1].trim() : '';
}

function extractAssignedDocumentTitles(userMessage) {
  const titles = [];
  const regex = /^- title: ("(?:\\.|[^"\\])*")\s*(?:,|$)/gm;
  let match;
  while ((match = regex.exec(userMessage))) {
    try { titles.push(JSON.parse(match[1])); } catch { /* skip malformed titles */ }
  }
  return titles;
}

function defaultAssignResponse({ userMessage }) {
  return {
    documents: extractAssignedDocumentTitles(userMessage).map(title => ({ title, files: [] })),
  };
}

function defaultPageResponse({ title, userMessage }) {
  const cite = userMessage.match(/<cite>[\s\S]*?<\/cite>/);
  const range = userMessage.match(
    /- \[[^\]]+:L\d+-L\d+\]\([^)]+#L\d+-L\d+\)/
  );
  const depth = userMessage.match(/(\d+)-(\d+) H2 sections and (\d+)-(\d+) words/);
  const sectionCount = depth ? Number(depth[1]) : 4;
  const minimumWords = depth ? Number(depth[3]) : 300;
  const wordsPerSection = Math.ceil(minimumWords / sectionCount);
  const childLinks = extractChildLinks(userMessage);
  const sections = [];

  for (let index = 0; index < sectionCount; index++) {
    const body = Array.from(
      { length: wordsPerSection },
      (_, word) => `grounded${index + 1}_${word + 1}`
    ).join(' ');
    const additions = [];
    if (index === 0 && childLinks) additions.push(childLinks);
    if (index === 0 && range) {
      additions.push('**Section sources**', range[0]);
    }
    sections.push(
      `## Section ${index + 1}\n\n${additions.length ? `${additions.join('\n')}\n\n` : ''}${body}.`
    );
  }

  return [
    `# ${title}`,
    cite ? cite[0] : '',
    sections.join('\n\n'),
  ].filter(Boolean).join('\n\n');
}

function defaultKnowledgeResponse({ cardName }) {
  return [
    `This card documents ${cardName || 'repository knowledge'} from attached sources.`,
    '',
    '- The recorded behavior is limited to the supplied files.',
    '- Paths and commands are included only when visible in those sources.',
  ].join('\n');
}

function extractTagged(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : '';
}

function extractModifyAttached(userMessage) {
  const block = String(userMessage).match(
    /Attached source files \(the ONLY citable sources\):\n((?:- \[[^\n]+\]\([^)]+\)\n?)*)/
  );
  if (!block) return [];
  return [...block[1].matchAll(/- \[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
}

function modifyWords(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`).join(' ');
}

function defaultModifyResponse({ title, userMessage }) {
  const current = extractTagged(userMessage, 'current_page');
  const operationMatch = String(userMessage).match(/\b(SUPPLEMENT|REWRITE|MODIFY):/);
  const operation = operationMatch ? operationMatch[1].toLowerCase() : 'modify';
  const attached = extractModifyAttached(userMessage);
  const cite = attached.length
    ? `<cite>\n**Referenced Files in This Document**\n${attached.map(rel => `- [${rel}](${rel})`).join('\n')}\n</cite>`
    : '';
  const range = attached.length
    ? `**Section sources**\n- [${attached[0]}:L1-L1](${attached[0]}#L1-L1)`
    : '';

  if (operation === 'supplement') {
    const base = current || [`# ${title}`, cite].filter(Boolean).join('\n\n');
    const section = `## Mock Provider\n\n${range ? `${range}\n\n` : ''}${modifyWords('supplement', 70)}.`;
    return `${base.trim()}\n\n${section}`;
  }

  if (operation === 'rewrite') {
    const sections = [];
    for (let index = 1; index <= 5; index++) {
      const sources = index === 1 && range ? `${range}\n\n` : '';
      sections.push(`## Rewritten Section ${index}\n\n${sources}${modifyWords(`rewrite${index}`, 70)}.`);
    }
    return [`# ${title}`, cite, sections.join('\n\n')].filter(Boolean).join('\n\n');
  }

  // modify: keep the existing page, rewrite one section's prose in place
  if (current) {
    return current
      .replace(/^(## [^\n]+)\n\n[\s\S]*?(?=\n## |\n<cite>|$)/m, `$1\n\n${range ? `${range}\n\n` : ''}${modifyWords('modified', 70)}.`)
      .trim();
  }
  const sections = [];
  for (let index = 1; index <= 4; index++) {
    const sources = index === 1 && range ? `${range}\n\n` : '';
    sections.push(`## Modified Section ${index}\n\n${sources}${modifyWords(`modified${index}`, 70)}.`);
  }
  return [`# ${title}`, cite, sections.join('\n\n')].filter(Boolean).join('\n\n');
}

function createMockServer({
  plan = DEFAULT_PLAN,
  planResponder,
  pageResponder = defaultPageResponse,
  knowledgeResponder = defaultKnowledgeResponse,
  assignResponder,
  modifyResponder,
  finishReasonResponder = () => 'stop',
  delay = 0,
} = {}) {
  const state = {
    requests: 0,
    planRequests: 0,
    pageRequests: 0,
    repairRequests: 0,
    knowledgeRequests: 0,
    assignRequests: 0,
    modifyRequests: 0,
    lastPlanRunRequests: 0,
    byTitle: {},
    requestBodies: [],
  };

  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      if (!request.url.endsWith('/chat/completions')) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      try {
        const payload = JSON.parse(body);
        const systemMessage = payload.messages
          .filter(message => message.role === 'system')
          .map(message => message.content)
          .join('\n');
        const userMessage = payload.messages
          .filter(message => message.role === 'user')
          .map(message => message.content)
          .join('\n');
        state.requests++;
        state.requestBodies.push({ body });

        let content;
        let responseContext;
        if (/assigning source files to documentation pages/i.test(systemMessage)) {
          state.assignRequests++;
          const chosen = assignResponder
            ? await assignResponder({
              payload,
              state,
              systemMessage,
              userMessage,
              defaultResponse: () => defaultAssignResponse({ userMessage }),
            })
            : defaultAssignResponse({ userMessage });
          content = typeof chosen === 'string' ? chosen : JSON.stringify(chosen);
          responseContext = {
            kind: 'assign',
            title: null,
            attempt: state.assignRequests,
          };
        } else if (/valid JSON only/i.test(systemMessage)) {
          const isRepair = /repairing a rejected wiki plan/i.test(systemMessage);
          if (!isRepair) state.lastPlanRunRequests = 0;
          state.planRequests++;
          state.lastPlanRunRequests++;
          const chosen = planResponder
            ? await planResponder({
              attempt: state.lastPlanRunRequests,
              defaultPlan: plan,
              payload,
              state,
              systemMessage,
              userMessage,
            })
            : plan;
          content = typeof chosen === 'string'
            ? chosen
            : `Here is the plan:\n\`\`\`json\n${JSON.stringify(chosen)}\n\`\`\``;
          responseContext = {
            kind: 'plan',
            title: null,
            attempt: state.lastPlanRunRequests,
          };
        } else if (/knowledge card/i.test(systemMessage)) {
          state.knowledgeRequests++;
          const cardMatch = userMessage.match(/Card: "([^"]+)"/);
          const cardName = cardMatch && cardMatch[1];
          content = await knowledgeResponder({
            cardName,
            payload,
            state,
            systemMessage,
            userMessage,
          });
          responseContext = {
            kind: 'knowledge',
            title: cardName,
            attempt: state.knowledgeRequests,
          };
        } else if (/editing an existing wiki page/i.test(systemMessage)) {
          state.modifyRequests++;
          content = await (modifyResponder
            ? modifyResponder({
              payload,
              state,
              systemMessage,
              userMessage,
              defaultResponse: () => defaultModifyResponse({ title: extractTitle(userMessage), userMessage }),
            })
            : defaultModifyResponse({ title: extractTitle(userMessage), userMessage }));
          responseContext = {
            kind: 'modify',
            title: extractTitle(userMessage),
            attempt: state.modifyRequests,
          };
        } else {
          const title = extractTitle(userMessage);
          const isRepair = /repairing a rejected/i.test(systemMessage);
          state.pageRequests++;
          if (isRepair) state.repairRequests++;
          state.byTitle[title] = (state.byTitle[title] || 0) + 1;
          content = await pageResponder({
            title,
            isRepair,
            payload,
            state,
            systemMessage,
            userMessage,
            defaultResponse: () => defaultPageResponse({ title, userMessage }),
          });
          responseContext = {
            kind: 'page',
            title,
            attempt: state.byTitle[title],
          };
        }

        const finishReason = await finishReasonResponder({
          ...responseContext,
          payload,
          state,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        const reply = JSON.stringify({
          choices: [{
            finish_reason: finishReason || null,
            message: { role: 'assistant', content: String(content) },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
          },
        });
        setTimeout(() => response.end(reply), delay);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error.stack || error.message);
      }
    });
  });
  server.state = state;
  // Convenience helpers for the fixed-port integration tests (test/config.json
  // points at http://127.0.0.1:8688/v1). Existing tests may still use listen(0)
  // directly for an ephemeral port.
  server.start = (port = 8688) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.stop = () => new Promise(resolve => server.close(resolve));
  server.requests = () => state.requestBodies;
  return server;
}

if (require.main === module) {
  const server = createMockServer({
    delay: Number.parseInt(process.env.MOCK_DELAY_MS, 10) || 0,
  });
  const port = Number.parseInt(process.env.MOCK_PORT, 10) || 8688;
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock LLM on http://127.0.0.1:${port}/v1`);
  });
}

module.exports = {
  createMockServer,
  defaultPageResponse,
  defaultKnowledgeResponse,
  defaultAssignResponse,
  defaultModifyResponse,
  DEFAULT_PLAN,
};
