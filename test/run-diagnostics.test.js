'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunDiagnostics } = require('../lib/run-diagnostics');

test('persists plan and page attempt evidence without unsafe paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const diagnostics = createRunDiagnostics(root, {
    runId: '20260729T120000Z-123',
    provider: 'openai',
    model: 'mock',
    flags: { prune: false },
  });

  diagnostics.recordPlanAttempt(1, '{"pages":[]}', {
    normalizedPlan: { pages: [] },
    finishReason: 'stop',
    usage: { completion_tokens: 3 },
    violations: [{ code: 'plan_page_regression' }],
  });
  diagnostics.acceptPlan({
    pages: [{ path: 'overview.md', title: 'Overview' }],
  });
  diagnostics.recordPageAttempt('guides/start.md', 1, '# Draft', {
    finishReason: 'length',
    violations: [{ code: 'completion_truncated' }],
  });
  diagnostics.finish('aborted', { pageFailures: 1 });

  const summary = JSON.parse(
    fs.readFileSync(path.join(diagnostics.dir, 'run.json'), 'utf8')
  );
  assert.equal(summary.status, 'aborted');
  assert.equal(summary.pageFailures, 1);
  assert.equal(summary.provider, 'openai');
  assert.ok(summary.startedAt);
  assert.ok(summary.finishedAt);
  assert.equal(
    fs.readFileSync(path.join(diagnostics.dir, 'plan/attempt-1.raw.txt'), 'utf8'),
    '{"pages":[]}'
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(
      path.join(diagnostics.dir, 'plan/attempt-1.json'),
      'utf8'
    )).violations,
    [{ code: 'plan_page_regression' }]
  );
  assert.equal(fs.existsSync(path.join(
    diagnostics.dir,
    'plan/accepted.normalized.json'
  )), true);
  assert.equal(fs.existsSync(path.join(
    diagnostics.dir,
    'pages/guides/start/attempt-1.md'
  )), true);
  assert.throws(
    () => diagnostics.writeText('../escape.txt', 'no'),
    /unsafe diagnostic path/
  );
  assert.throws(
    () => diagnostics.writeJson('/absolute.json', {}),
    /unsafe diagnostic path/
  );
});

test('rejects unsafe run IDs before creating output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createRunDiagnostics(root, { runId: '../escape' }),
    /unsafe diagnostic run ID/
  );
});

test('keeps diagnostic page paths distinct after encoding', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const diagnostics = createRunDiagnostics(root, {
    runId: '20260729T120001Z-456',
  });

  diagnostics.recordPageAttempt('guides/a b.md', 1, '# Space', {});
  diagnostics.recordPageAttempt('guides/a-b.md', 1, '# Dash', {});

  const pageRoot = path.join(diagnostics.dir, 'pages/guides');
  const attempts = fs.readdirSync(pageRoot)
    .map(name => path.join(pageRoot, name, 'attempt-1.md'))
    .filter(file => fs.existsSync(file));
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map(file => fs.readFileSync(file, 'utf8')).sort(),
    ['# Dash', '# Space']
  );
});
