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
const CONFIG = path.join(__dirname, 'config.json');

// The fixture repo only contains a.js, b.js and package.json, so the mock plan
// must stay within those files (normalizePlan rejects plans that cite files the
// scan does not know about).
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

function runGenerator(repo, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, repo, '--config', CONFIG, ...extraArgs], {
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-protect-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"protect-fixture","version":"1.0.0"}\n');
  return repo;
}

test('externally edited page is protected, not clobbered, when its sources change', async () => {
  const server = createMockServer({ plan: FIXTURE_PLAN });
  await server.start();
  try {
    const repo = makeRepo();
    const first = await runGenerator(repo);
    assert.equal(first.code, 0, first.stderr);

    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    const original = fs.readFileSync(pageFile, 'utf8');
    const humanEdit = original.replace(/^# /m, '# HUMAN-EDITED ');
    fs.writeFileSync(pageFile, humanEdit);

    // change a source the page depends on -> input hash drifts
    const dep = target.dependent_files[0] || 'a.js';
    fs.appendFileSync(path.join(repo, dep), '\n// drift\n');

    const second = await runGenerator(repo);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /protected: externally-modified/);
    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(after.startsWith('# HUMAN-EDITED'), 'human edit must survive regeneration');
    assert.ok(!after.includes('GEN'), 'page must not be a fresh generation');

    const catalog2 = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const meta2 = catalog2.pages.find(p => p.path === target.path);
    assert.equal(meta2.protected, true, 'catalog marks the page as protected');
  } finally {
    await server.stop();
  }
});

test('--force overwrites an externally edited page', async () => {
  const server = createMockServer({ plan: FIXTURE_PLAN });
  await server.start();
  try {
    const repo = makeRepo();
    assert.equal((await runGenerator(repo)).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    fs.writeFileSync(pageFile, fs.readFileSync(pageFile, 'utf8').replace(/^# /m, '# HUMAN-EDITED '));
    const forced = await runGenerator(repo, ['--force']);
    assert.equal(forced.code, 0, forced.stderr);
    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(!after.startsWith('# HUMAN-EDITED'), '--force regenerates over the human edit');
  } finally {
    await server.stop();
  }
});
