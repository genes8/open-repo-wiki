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

const LANDING_PLAN = {
  pages: [
    {
      path: 'overview.md',
      title: 'Project Overview',
      description: 'Overview of the fixture repository',
      files: ['a.js', 'b.js'],
    },
    {
      path: 'guides/guides.md',
      title: 'Guides',
      description: 'Section landing page',
      files: ['a.js'],
    },
    {
      path: 'guides/getting-started.md',
      title: 'Getting Started',
      description: 'Install and run',
      files: ['a.js'],
    },
    {
      path: 'guides/configuration.md',
      title: 'Configuration',
      description: 'Config options',
      files: ['b.js'],
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
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-modify-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"modify-fixture","version":"1.0.0"}\n');
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

test('supplement appends content and marks the page curated/protected', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo);
  try {
    assert.equal((await runCli([repo, '--config', configPath])).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    const before = fs.readFileSync(pageFile, 'utf8');

    const mod = await runCli([repo, '--config', configPath,
      '--modify', target.path, '--op', 'supplement',
      '--instruction', 'Add a section about the mock provider']);
    assert.equal(mod.code, 0, mod.stderr);

    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(after.length > before.length, 'supplement must not shrink the page');
    assert.ok(after.includes(before.replace(/^# .*$/m, after.match(/^# .*$/m)[0])) || after.startsWith(before.split('\n')[0]),
      'original heading/structure must survive a supplement');

    const catalog2 = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const meta2 = catalog2.pages.find(p => p.path === target.path);
    assert.equal(meta2.protected, true, 'modified page becomes protected (curated)');

    // code drift on a dependent file must NOT clobber the curated page
    const dep = target.dependent_files[0] || 'a.js';
    fs.appendFileSync(path.join(repo, dep), '\n// drift\n');
    const drift = await runCli([repo, '--config', configPath]);
    assert.equal(drift.code, 0, drift.stderr);
    assert.match(drift.stdout, /protected: curated/);
    assert.equal(fs.readFileSync(pageFile, 'utf8'), after, 'curated page survives regeneration');
  } finally {
    await server.stop();
  }
});

test('modify fails cleanly for an unknown page path', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo);
  try {
    assert.equal((await runCli([repo, '--config', configPath])).code, 0);
    const mod = await runCli([repo, '--config', configPath, '--modify', 'nope.md', '--op', 'rewrite', '--instruction', 'x']);
    assert.notEqual(mod.code, 0);
    assert.match(mod.stderr, /nope\.md/);
  } finally {
    await server.stop();
  }
});

test('modify a landing page succeeds with the landing profile', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo, LANDING_PLAN);
  try {
    assert.equal((await runCli([repo, '--config', configPath])).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const landing = catalog.pages.find(p => p.isLanding);
    assert.ok(landing, 'fixture must include a landing page');

    const mod = await runCli([repo, '--config', configPath,
      '--modify', landing.path,
      '--instruction', 'Rewrite the first section to describe the mock provider']);
    assert.equal(mod.code, 0, mod.stderr);
    assert.match(fs.readFileSync(path.join(repo, '.local-wiki/en/content', landing.path), 'utf8'), /modified_/);
  } finally {
    await server.stop();
  }
});

test('catalog fallback protects a curated page after .state.json is lost', async () => {
  const repo = makeRepo();
  const { server, configPath } = await startMock(repo);
  try {
    assert.equal((await runCli([repo, '--config', configPath])).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);

    assert.equal((await runCli([repo, '--config', configPath,
      '--modify', target.path, '--op', 'supplement',
      '--instruction', 'Add a section about the mock provider'])).code, 0);
    const modified = fs.readFileSync(pageFile, 'utf8');

    fs.unlinkSync(path.join(repo, '.local-wiki/en/content', '.state.json'));
    const dep = target.dependent_files[0] || 'a.js';
    fs.appendFileSync(path.join(repo, dep), '\n// drift\n');
    const drift = await runCli([repo, '--config', configPath]);
    assert.equal(drift.code, 0, drift.stderr);
    assert.match(drift.stdout, /protected: curated/);
    assert.equal(fs.readFileSync(pageFile, 'utf8'), modified, 'catalog metadata protects the modified page');
  } finally {
    await server.stop();
  }
});
