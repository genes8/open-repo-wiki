'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventBus, createHumanReporter, createNdjsonReporter } = require('../lib/events');

test('createEventBus delivers every emit as an event with type and ts', () => {
  const { bus, emit } = createEventBus();
  const seen = [];
  bus.on('event', e => seen.push(e));
  emit('run_started', { model: 'mock' });
  emit('page_done', { path: 'overview.md', status: 'generated' });
  assert.deepEqual(seen.map(e => e.type), ['run_started', 'page_done']);
  assert.equal(seen[0].model, 'mock');
  assert.ok(typeof seen[0].ts === 'string' && seen[0].ts.length > 0);
});

test('ndjson reporter writes one JSON object per line', () => {
  const lines = [];
  const report = createNdjsonReporter(line => lines.push(line));
  report({ type: 'run_started', ts: '2026-10-04T00:00:00Z', model: 'mock' });
  report({ type: 'page_done', ts: '2026-10-04T00:00:01Z', path: 'a.md', status: 'generated' });
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'run_started', ts: '2026-10-04T00:00:00Z', model: 'mock' });
  assert.equal(JSON.parse(lines[1]).status, 'generated');
});

test('human reporter maps page statuses to the CLI labels', () => {
  const out = [];
  const report = createHumanReporter(line => out.push(line));
  report({ type: 'page_done', path: 'overview.md', status: 'generated', chars: 100, files: 2 });
  report({ type: 'page_done', path: 'a.md', status: 'protected', reason: 'externally-modified' });
  report({ type: 'page_fail', path: 'b.md', message: 'boom' });
  assert.deepEqual(out, [
    '  OK    overview.md (100 chars, 2 source files)',
    '  SKIP  a.md (protected: externally-modified)',
    '  FAIL  b.md: boom',
  ]);
});

test('payload cannot override type or ts', () => {
  const { bus, emit } = createEventBus();
  const seen = [];
  bus.on('event', e => seen.push(e));
  emit('page_done', { type: 'run_started', ts: 'bogus', path: 'a.md' });
  assert.equal(seen[0].type, 'page_done');
  assert.notEqual(seen[0].ts, 'bogus');
});

test('human reporter survives an unknown page status', () => {
  const out = [];
  createHumanReporter(line => out.push(line))({ type: 'page_done', path: 'x.md', status: 'wat' });
  assert.equal(out.length, 1);
  assert.match(out[0], /SKIP/);
});

test('a throwing reporter does not break emit', () => {
  const { bus, emit } = createEventBus();
  bus.on('event', () => { throw new Error('renderer boom'); });
  emit('page_done', { path: 'a.md' }); // must not throw
});
