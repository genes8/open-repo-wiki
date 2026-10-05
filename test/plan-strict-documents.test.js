'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');

function runGenerator(repo, config, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, repo, '--config', config, ...extraArgs], {
      cwd: APP_DIR, env: { ...process.env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-docs-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/payments.js'), 'function charge() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'src/orders.js'), 'function order() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'src/legacy.js'), 'function legacy() { return 3; }\n');
  return repo;
}

async function startMock(repo) {
  const server = createMockServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const configPath = path.join(repo, 'repo-wiki.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    default: 'mock',
    language: 'en',
    maxPages: 10,
    models: {
      mock: {
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'mock-1',
        contextChars: 20000,
        maxTokens: 2048,
      },
    },
  }, null, 2)}\n`);
  return { server, configPath };
}

const PLAN = `version: 1
repowiki:
  notes:
    - text: "Focus on business workflows rather than code details"
  documents:
    - title: "Payments Guide"
      goal: "Explain how charging works"
    - title: "Order Flow"
      goal: "Explain the order lifecycle"
      parent: "Payments Guide"
      hints: "Mention refunds"
`;

test('strict documents mode outputs exactly the listed pages', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo);
  try {
    fs.writeFileSync(path.join(repo, 'wiki_plan.yaml'), PLAN);
    const run = await runGenerator(repo, configPath);
    assert.equal(run.code, 0, run.stderr);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const paths = catalog.pages.map(p => p.path).sort();
    // Payments Guide is a parent -> landing page in its own directory
    assert.ok(paths.includes('payments-guide/payments-guide.md'), `got: ${paths.join(', ')}`);
    assert.ok(paths.includes('payments-guide/order-flow.md'), `got: ${paths.join(', ')}`);
    assert.equal(catalog.pages.length, 2, 'exactly the two planned documents, nothing more');
    const orderPage = catalog.pages.find(p => p.path.endsWith('order-flow.md'));
    assert.equal(orderPage.parent, 'payments-guide/payments-guide.md');
  } finally {
    await server.stop();
  }
});

test('planned page metadata keeps goal as description and hints reach the page prompt', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo);
  try {
    fs.writeFileSync(path.join(repo, 'wiki_plan.yaml'), PLAN);
    const run = await runGenerator(repo, configPath);
    assert.equal(run.code, 0, run.stderr);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const orderPage = catalog.pages.find(p => p.path.endsWith('order-flow.md'));
    assert.match(orderPage.description, /order lifecycle/i);
    // the mock server records requests; assert the hint text reached the prompt
    const requests = server.requests();
    const pagePrompt = requests.find(r => r.body.includes('Author hints:'));
    assert.ok(pagePrompt, 'page prompt with author hints must be sent');
    assert.ok(String(pagePrompt.body).includes('Mention refunds'), 'hints must reach the page prompt');
  } finally {
    await server.stop();
  }
});
