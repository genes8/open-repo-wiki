'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { gitHasCommit } = require('../lib/api');
const { createMockServer } = require('./mock-llm');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');

function runGenerator(repo, config, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      GENERATOR,
      repo,
      '--config',
      config,
      '--concurrency',
      '1',
      ...extraArgs,
    ], {
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

test('gitHasCommit is false without .git, true for a real repo', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-git-'));
  assert.equal(gitHasCommit(empty), false);
  assert.equal(gitHasCommit(path.resolve(__dirname, '..')), true); // this repo has commits
});

test('gitHasCommit resolves packed refs and returns false with no refs', t => {
  const sha = 'a'.repeat(40);

  // packed-refs variant: HEAD points at a branch whose only ref lives in
  // packed-refs (no loose ref file), so the commit must be resolved from there.
  const packedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-packed-'));
  t.after(() => fs.rmSync(packedRepo, { recursive: true, force: true }));
  const packedGit = path.join(packedRepo, '.git');
  fs.mkdirSync(packedGit, { recursive: true });
  fs.writeFileSync(path.join(packedGit, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(packedGit, 'packed-refs'), `${sha} refs/heads/main\n`);
  assert.equal(gitHasCommit(packedRepo), true);

  // no-refs variant: HEAD points at a branch with neither a loose nor packed ref.
  const noRefsRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-norefs-'));
  t.after(() => fs.rmSync(noRefsRepo, { recursive: true, force: true }));
  const noRefsGit = path.join(noRefsRepo, '.git');
  fs.mkdirSync(noRefsGit, { recursive: true });
  fs.writeFileSync(path.join(noRefsGit, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(gitHasCommit(noRefsRepo), false);
});

test('non-git repo still generates and emits a scan warning', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-nogit-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'function run() { return true; }\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');

  const server = createMockServer({
    plan: {
      pages: [
        { path: 'overview.md', title: 'Overview', description: 'What the project does', files: ['README.md'] },
        { path: 'src/start.md', title: 'Start', description: 'How to run it', files: ['src/app.js'] },
        { path: 'src/configuration.md', title: 'Configuration', description: 'How to configure it', files: ['src/app.js'] },
      ],
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const configPath = path.join(repo, 'repo-wiki.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    default: 'mock',
    language: 'en',
    maxPages: 5,
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

  try {
    const run = await runGenerator(repo, configPath);
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stdout + run.stderr,
      /not a Git repository with at least one commit — Qoder requires one; continuing anyway/
    );
  } finally {
    await server.stop();
  }
});
