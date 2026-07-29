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
  const match = userMessage.match(/Write the wiki page "([^"]+)"/);
  return match ? match[1] : 'Page';
}

function extractChildLinks(userMessage) {
  const block = userMessage.match(
    /Include every child using these exact links:\n((?:- \[[^\n]+\]\([^)]+\)\n?)+)/
  );
  return block ? block[1].trim() : '';
}

function defaultPageResponse({ title, userMessage }) {
  const cite = userMessage.match(/<cite>[\s\S]*?<\/cite>/);
  const range = userMessage.match(
    /- \[[^\]]+:L\d+-L\d+\]\([^)]+#L\d+-L\d+\)/
  );
  const depth = userMessage.match(/Write (\d+)-(\d+) H2 sections and (\d+)-(\d+) words/);
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
      `## Section ${index + 1}\n\n${additions.length ? `${additions.join('\n')}\n\n` : ''}${body}`
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

function createMockServer({
  plan = DEFAULT_PLAN,
  pageResponder = defaultPageResponse,
  knowledgeResponder = defaultKnowledgeResponse,
  delay = 0,
} = {}) {
  const state = {
    requests: 0,
    planRequests: 0,
    pageRequests: 0,
    repairRequests: 0,
    knowledgeRequests: 0,
    byTitle: {},
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

        let content;
        if (/valid JSON only/i.test(systemMessage)) {
          state.planRequests++;
          content = `Here is the plan:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
        } else if (/knowledge card/i.test(systemMessage)) {
          state.knowledgeRequests++;
          const cardMatch = userMessage.match(/Card: "([^"]+)"/);
          content = await knowledgeResponder({
            cardName: cardMatch && cardMatch[1],
            payload,
            state,
            systemMessage,
            userMessage,
          });
        } else {
          const title = extractTitle(userMessage);
          const isRepair = /repairing a rejected draft/i.test(systemMessage);
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
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        const reply = JSON.stringify({
          choices: [{ message: { role: 'assistant', content: String(content) } }],
        });
        setTimeout(() => response.end(reply), delay);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error.stack || error.message);
      }
    });
  });
  server.state = state;
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
  DEFAULT_PLAN,
};
