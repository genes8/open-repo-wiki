import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunProgress } from '../src/pure/progress.js';

test('maps the event stream to progress messages and increments', () => {
  const p = createRunProgress();
  const planned = p({ type: 'plan_ready', ts: 'x', pages: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] });
  assert.ok(planned, 'plan_ready must update the progress message');
  assert.match(planned!.message, /planned 2 pages/);
  const done = p({ type: 'page_done', ts: 'x', path: 'a.md', status: 'generated' });
  assert.ok(done);
  assert.match(done!.message, /a\.md \(1\/2\)/);
  assert.ok(done!.increment > 0);
  const fail = p({ type: 'page_fail', ts: 'x', path: 'b.md', message: 'boom' });
  assert.ok(fail);
  assert.match(fail!.message, /b\.md/);
});

test('irrelevant events map to null; unknown totals degrade gracefully', () => {
  const p = createRunProgress();
  assert.equal(p({ type: 'scan_done', ts: 'x', files: 9 }), null);
  const done = p({ type: 'page_done', ts: 'x', path: 'a.md', status: 'cached' as never });
  assert.ok(done);
  assert.match(done!.message, /a\.md \(1\//);
});
