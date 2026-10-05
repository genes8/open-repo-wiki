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

// The fixture repo only contains a.js, b.js and package.json, so the mock plan
// must stay within those files (normalizePlan rejects plans that cite files the
// scan does not know about) and avoid singleton directories (plan-quality).
const FIXTURE_PLAN = {
  pages: [
    {
      path: 'overview.md',
      title: 'Project Overview',
      description: 'Overview of the fixture repository',
      files: ['a.js', 'b.js'],
    },
    {
      path: 'alpha.md',
      title: 'Alpha Module',
      description: 'The alpha module',
      files: ['a.js'],
    },
  ],
};

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, ...args], {
      cwd: APP_DIR,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ndjson-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ndjson-fixture","version":"1.0.0"}\n');
  return repo;
}

async function startMock(repo, plan = FIXTURE_PLAN) {
  const server = createMockServer({ plan });
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

// Every stdout line must be a single JSON object: this is the machine contract.
// If any human text (e.g. a stray console.log or an unrouted dotenv message)
// leaks onto stdout, JSON.parse throws and the assertion fails on purpose.
function parseJsonLines(stdout) {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('--json-events emits a parseable NDJSON event stream on stdout', async t => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { server, configPath } = await startMock(repo);
  t.after(() => server.stop());

  const run = await runCli([
    repo,
    '--config', configPath,
    '--concurrency', '1',
    '--json-events',
  ]);
  assert.equal(run.code, 0, run.stderr);

  const events = parseJsonLines(run.stdout);
  assert.ok(events.length > 0, 'expected at least one NDJSON event on stdout');

  // An app-dir .env (gitignored, present in real checkouts) legitimately emits
  // env_loaded before run_started, so run_started must simply precede the
  // page/plan events and any pre-run events may only be env_loaded.
  const runStartedIndex = events.findIndex(event => event.type === 'run_started');
  assert.ok(runStartedIndex !== -1, `no run_started event (got: ${events.map(e => e.type).join(', ')})`);
  for (const before of events.slice(0, runStartedIndex)) {
    assert.equal(before.type, 'env_loaded', `unexpected pre-run event ${before.type}`);
  }
  assert.equal(events.at(-1).type, 'run_finished', `last event was ${events.at(-1).type}`);

  const types = new Set(events.map(event => event.type));
  for (const required of ['scan_done', 'plan_ready', 'page_done', 'run_finished']) {
    assert.ok(types.has(required), `missing "${required}" event (got: ${[...types].sort().join(', ')})`);
  }

  for (const event of events) {
    assert.equal(typeof event.type, 'string', `event missing string type: ${JSON.stringify(event)}`);
    assert.equal(typeof event.ts, 'string', `event missing string ts: ${JSON.stringify(event)}`);
    assert.ok(event.ts.length > 0, 'event ts must be non-empty');
  }

  const finished = events.at(-1);
  assert.ok(finished.stats && typeof finished.stats === 'object', 'run_finished must carry a stats object');
  for (const key of ['generated', 'degraded', 'skipped', 'failed', 'knowledgeFailed']) {
    assert.equal(typeof finished.stats[key], 'number', `stats.${key} must be a number`);
  }
});

test('--list-models --json-events emits only model_profile events', async t => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { server, configPath } = await startMock(repo);
  t.after(() => server.stop());

  const run = await runCli([
    repo,
    '--config', configPath,
    '--list-models',
    '--json-events',
  ]);
  assert.equal(run.code, 0, run.stderr);

  const events = parseJsonLines(run.stdout);
  assert.ok(events.length > 0, 'expected at least one model_profile event');
  assert.ok(events.every(event => event.type === 'model_profile'), 'only model_profile events allowed');

  const mock = events.find(event => event.name === 'mock');
  assert.ok(mock, 'expected a model_profile event for the "mock" profile');
  assert.equal(mock.default, true);
  assert.equal(mock.provider, 'openai');
  assert.equal(mock.model, 'mock-1');
});
