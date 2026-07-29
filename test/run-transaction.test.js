'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunTransaction } = require('../lib/run-transaction');

function snapshotTree(root) {
  function walk(current) {
    const out = {};
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) out[`${entry.name}/`] = walk(full);
      else if (entry.isSymbolicLink()) out[entry.name] = `link:${fs.readlinkSync(full)}`;
      else out[entry.name] = fs.readFileSync(full, 'utf8');
    }
    return out;
  }
  return walk(root);
}

function transactionFixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'wiki-tx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  const meta = path.join(root, 'meta');
  fs.mkdirSync(content);
  fs.mkdirSync(meta);
  fs.writeFileSync(path.join(content, 'page.md'), 'original page');
  fs.writeFileSync(path.join(meta, 'catalog.json'), '{"old":true}\n');
  return { root, content, meta };
}

test('prepare snapshots every live target into its stage', t => {
  const fixture = transactionFixture(t);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-0');

  tx.prepare();

  assert.equal(
    fs.readFileSync(path.join(tx.stagePath('content'), 'page.md'), 'utf8'),
    'original page'
  );
  assert.equal(
    fs.readFileSync(path.join(tx.stagePath('meta'), 'catalog.json'), 'utf8'),
    '{"old":true}\n'
  );
});

test('prepare supports a missing live target beneath a missing parent', t => {
  const fixture = transactionFixture(t);
  const live = path.join(fixture.root, 'knowledge', 'en');
  const tx = createRunTransaction([{ name: 'knowledge', live }], 'run-new');

  tx.prepare();

  assert.equal(fs.statSync(tx.stagePath('knowledge')).isDirectory(), true);
  tx.abort();
  assert.equal(fs.existsSync(live), false);
});

test('abort leaves live trees byte-identical', t => {
  const fixture = transactionFixture(t);
  const before = snapshotTree(fixture.root);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-1');
  tx.prepare();
  fs.writeFileSync(path.join(tx.stagePath('content'), 'page.md'), 'changed');

  tx.abort();

  assert.deepEqual(snapshotTree(fixture.root), before);
});

test('commit publishes every staged target and removes transaction artifacts', t => {
  const fixture = transactionFixture(t);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-success');
  tx.prepare();
  fs.writeFileSync(path.join(tx.stagePath('content'), 'page.md'), 'next page');
  fs.writeFileSync(path.join(tx.stagePath('meta'), 'catalog.json'), '{"next":true}\n');

  tx.commit();

  assert.equal(fs.readFileSync(path.join(fixture.content, 'page.md'), 'utf8'), 'next page');
  assert.equal(
    fs.readFileSync(path.join(fixture.meta, 'catalog.json'), 'utf8'),
    '{"next":true}\n'
  );
  assert.deepEqual(
    fs.readdirSync(fixture.root).sort(),
    ['content', 'meta']
  );
});

test('commit failure rolls every live target back', t => {
  const fixture = transactionFixture(t);
  const before = snapshotTree(fixture.root);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-2');
  tx.prepare();
  fs.writeFileSync(path.join(tx.stagePath('content'), 'page.md'), 'changed');
  fs.rmSync(tx.stagePath('meta'), { recursive: true, force: true });

  assert.throws(() => tx.commit(), /missing transaction stage/);
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test('rejects overlapping and symlinked live targets', t => {
  const fixture = transactionFixture(t);
  const child = path.join(fixture.content, 'nested');
  fs.mkdirSync(child);
  assert.throws(
    () => createRunTransaction([
      { name: 'content', live: fixture.content },
      { name: 'nested', live: child },
    ], 'run-overlap'),
    /overlapping transaction targets/
  );

  const link = path.join(fixture.root, 'linked-content');
  fs.symlinkSync(fixture.content, link, 'dir');
  assert.throws(
    () => createRunTransaction([{ name: 'content', live: link }], 'run-link'),
    /symlink/
  );
});

test('rejects a filesystem root as a publication target', () => {
  assert.throws(
    () => createRunTransaction([
      { name: 'content', live: path.parse(process.cwd()).root },
    ], 'run-root'),
    /filesystem root/
  );
});
