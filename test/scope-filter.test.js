'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyScope } = require('../lib/scope-filter');

const scan = {
  files: [
    { rel: 'src/one.js', size: 10 },
    { rel: 'src/deep/two.js', size: 10 },
    { rel: 'src/test/three.js', size: 10 },
    { rel: 'docs/guide.md', size: 10 },
    { rel: 'lib.c', size: 10 },
  ],
};

test('include keeps only matching files, minus excludes', () => {
  const out = applyScope(scan, { include: ['src/**'], exclude: ['**/test/**'] });
  assert.deepEqual(out.files.map(f => f.rel).sort(), ['src/deep/two.js', 'src/one.js']);
});

test('exclude alone removes files', () => {
  const out = applyScope(scan, { include: [], exclude: ['*.md', '*.c'] });
  assert.deepEqual(out.files.map(f => f.rel).sort(), ['src/deep/two.js', 'src/one.js', 'src/test/three.js']);
});

test('empty scope is a no-op', () => {
  const out = applyScope(scan, { include: [], exclude: [] });
  assert.equal(out.files.length, 5);
  assert.equal(out, scan); // returns the same scan object untouched
});

test('tree and langStats are recomputed and fileSet rebuilt', () => {
  const out = applyScope(scan, { include: ['src/**'], exclude: ['**/test/**'] });
  assert.match(out.tree, /deep\//);
  assert.ok(out.fileSet.has('src/one.js') && !out.fileSet.has('docs/guide.md'));
  assert.match(out.langStats, /\.js: 2 files/);
});
