'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFilesBlock } = require('../lib/sources');

test('buildFilesBlock numbers attached lines while preserving raw source metadata', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-sources-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'a.js'), 'one\ntwo\nthree\n');
  const scan = { fileSet: new Set(['a.js']) };

  const result = buildFilesBlock(
    repo,
    { files: ['a.js', 'missing.js'] },
    scan,
    1000
  );

  assert.deepEqual(result.attached, ['a.js']);
  assert.equal(result.lineCounts['a.js'], 3);
  assert.match(result.block, /L1: one\nL2: two\nL3: three/);
  assert.equal(result.rawByPath['a.js'], 'one\ntwo\nthree\n');
});

test('buildFilesBlock respects the shared character budget', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-sources-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'a.js'), '12345\n67890\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'second\n');
  const scan = { fileSet: new Set(['a.js', 'b.js']) };

  const result = buildFilesBlock(repo, { files: ['a.js', 'b.js'] }, scan, 5);

  assert.deepEqual(result.attached, ['a.js']);
  assert.match(result.block, /a\.js \(truncated\)/);
  assert.equal(result.lineCounts['a.js'], 2);
  assert.equal(result.rawByPath['a.js'], '12345\n67890\n');
});

test('buildFilesBlock does not attach empty files that cannot support a line range', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-sources-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'empty.js'), '');
  fs.writeFileSync(path.join(repo, 'real.js'), 'content\n');
  const scan = { fileSet: new Set(['empty.js', 'real.js']) };

  const result = buildFilesBlock(
    repo,
    { files: ['empty.js', 'real.js'] },
    scan,
    1000
  );

  assert.deepEqual(result.attached, ['real.js']);
  assert.equal(Object.hasOwn(result.lineCounts, 'empty.js'), false);
  assert.equal(result.lineCounts['real.js'], 1);
});
