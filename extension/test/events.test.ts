import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNdjsonLine, isWikiEvent } from '../src/pure/events.js';

test('parses valid NDJSON lines into typed events', () => {
  const e = parseNdjsonLine('{"type":"page_done","ts":"2026-10-05T00:00:00Z","path":"a.md","status":"generated","chars":10,"files":2}');
  assert.ok(e);
  assert.equal(e.type, 'page_done');
  if (e.type === 'page_done') {
    assert.equal(e.path, 'a.md');
    assert.equal(e.status, 'generated');
    assert.equal(e.chars, 10);
    assert.equal(e.files, 2);
  }
});

test('rejects malformed lines and non-events', () => {
  assert.equal(parseNdjsonLine('not json'), null);
  assert.equal(parseNdjsonLine('{"type":"nope","ts":"x"}'), null);
  assert.equal(parseNdjsonLine('{"type":"page_done"}'), null); // missing ts
  assert.equal(parseNdjsonLine(''), null);
  assert.equal(parseNdjsonLine('{"type":123,"ts":"x"}'), null);
});

test('isWikiEvent accepts all 27 documented types', () => {
  const types = ['run_started','env_loaded','scan_started','scan_done','scan_warning',
    'plan_file_loaded','plan_started','plan_retry','plan_ready','dry_run','page_start',
    'page_retry','page_note','page_done','page_fail','stale_removed','catalog_written',
    'knowledge_started','knowledge_card_fail','knowledge_done','knowledge_failed_run',
    'run_note','run_aborted','run_finished','run_error','cleanup_warning','model_profile'];
  for (const t of types) {
    assert.ok(isWikiEvent({ type: t, ts: 'x' }), t);
  }
});
