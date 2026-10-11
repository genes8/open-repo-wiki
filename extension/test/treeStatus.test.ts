import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeStatus } from '../src/pure/treeStatus.js';

test('run_started emits a starting message and resets the badge', () => {
  const s = createTreeStatus();
  const started = s.step({ type: 'run_started', ts: 'x' });
  assert.deepEqual(started, { message: '⚡ Starting engine…', badge: 0 });
});

test('plan_ready emits 0/N and the badge stays at 0', () => {
  const s = createTreeStatus();
  s.step({ type: 'run_started', ts: 'x' });
  const planned = s.step({
    type: 'plan_ready',
    ts: 'x',
    pages: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }, { path: 'c.md', title: 'C' }],
  });
  assert.deepEqual(planned, { message: '⚡ Writing wiki — 0/3 pages', badge: 0 });
});

test('page_done and page_fail advance the counter and the badge', () => {
  const s = createTreeStatus();
  s.step({ type: 'run_started', ts: 'x' });
  s.step({ type: 'plan_ready', ts: 'x', pages: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }, { path: 'c.md', title: 'C' }] });

  const first = s.step({ type: 'page_done', ts: 'x', path: 'a.md', status: 'generated' });
  assert.deepEqual(first, { message: '⚡ 1/3 · a.md', badge: 1 });

  const second = s.step({ type: 'page_done', ts: 'x', path: 'b.md', status: 'generated' });
  assert.deepEqual(second, { message: '⚡ 2/3 · b.md', badge: 2 });

  const failed = s.step({ type: 'page_fail', ts: 'x', path: 'c.md', message: 'boom' });
  assert.deepEqual(failed, { message: '⚡ 3/3 · ⚠ c.md', badge: 3 });
});

test('run_finished emits null (the caller leaves the header to summary/clear)', () => {
  const s = createTreeStatus();
  s.step({ type: 'run_started', ts: 'x' });
  s.step({ type: 'plan_ready', ts: 'x', pages: [{ path: 'a.md', title: 'A' }] });
  s.step({ type: 'page_done', ts: 'x', path: 'a.md', status: 'generated' });
  assert.equal(s.step({ type: 'run_finished', ts: 'x', stats: { generated: 1, degraded: 0, skipped: 0, failed: 0, knowledgeFailed: 0 } }), null);
});

test('irrelevant events map to null', () => {
  const s = createTreeStatus();
  assert.equal(s.step({ type: 'scan_done', ts: 'x', files: 4 }), null);
});

test('summary renders generated+skipped pages, degraded count, and the model', () => {
  const s = createTreeStatus();
  const done = s.summary({ generated: 2, degraded: 1, skipped: 0 }, 'kimi');
  assert.deepEqual(done, { message: '✓ 2 pages · 1 degraded · kimi' });
  const noDegraded = s.summary({ generated: 1, degraded: 0, skipped: 2 }, 'ollama');
  assert.deepEqual(noDegraded, { message: '✓ 3 pages · ollama' });
});

test('clear resets the header message', () => {
  const s = createTreeStatus();
  assert.deepEqual(s.clear(), { message: '' });
});
