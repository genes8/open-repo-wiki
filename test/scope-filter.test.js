'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyScope, compilePattern } = require('../lib/scope-filter');

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

test('glob semantics: anchoring, trailing slash (literal and wildcard), mid **, deep bare names', () => {
  const files = ['src/a.js', 'src/test/b.js', 'test/c.js', 'app/src/d.js', 'docs/x.md'];
  const rel = p => ({ rel: p });
  const scanOf = list => ({ files: list.map(rel) });
  assert.ok(compilePattern('/src/**')(files[0]) === true);        // anchored: root src only
  assert.ok(compilePattern('/src/**')('app/src/d.js') === false); // not nested
  assert.ok(compilePattern('**/test/')(files[1]) === true);       // wildcard trailing slash
  assert.ok(compilePattern('**/test/')('test/c.js') === true);    // top-level dir itself
  assert.ok(compilePattern('**/test/')('src/other.js') === false);
  assert.ok(compilePattern('src/')('src/a.js') === true);         // literal trailing slash
  assert.ok(compilePattern('src/')('src/deep/x.js') === true);
  assert.ok(compilePattern('src/')('app/src/d.js') === true);     // gitignore: unanchored 'src/' matches any src dir
  assert.ok(compilePattern('src/**/gen/**')('src/x/gen/y.js') === true); // mid **
  assert.ok(compilePattern('*.md')('docs/x.md') === true);        // bare name anywhere
  // applyScope end-to-end with the previously-broken pattern
  const out = applyScope(scanOf(files), { include: [], exclude: ['**/test/'] });
  assert.deepEqual(out.files.map(f => f.rel).sort(), ['app/src/d.js', 'docs/x.md', 'src/a.js']);
});

test('applyScope filters keyFiles to the scoped fileSet', () => {
  const scan = { files: [{ rel: 'src/a.js', size: 1 }], keyFiles: { 'README.md': 'x', 'package.json': 'y' } };
  const out = applyScope(scan, { include: ['src/**'], exclude: [] });
  assert.deepEqual(Object.keys(out.keyFiles), []);
});
