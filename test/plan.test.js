'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlan, dirOf, groupPages } = require('../lib/plan');

const scan = {
  fileSet: new Set(['README.md', 'lib/a.js', 'lib/b.js', 'config.json']),
};

test('normalizePlan filters paths/files and synthesizes one landing per grouped directory', () => {
  const result = normalizePlan([
    { path: 'overview.md', title: 'Overview', files: ['README.md', 'missing.js'] },
    { path: 'guides/start.md', title: 'Start', files: ['README.md'] },
    { path: 'guides/config.md', title: 'Config', files: ['config.json'] },
    { path: '../overview.md', title: 'Duplicate', files: ['README.md'] },
  ], scan, { maxPages: 6 });

  assert.deepEqual(result.pages.map(p => p.path), [
    'overview.md',
    'guides/start.md',
    'guides/config.md',
    'guides/guides.md',
  ]);
  const landing = result.pages.find(p => p._landing);
  assert.deepEqual(landing.files, ['README.md', 'config.json']);
  assert.deepEqual(landing._children.map(p => p.path), ['guides/start.md', 'guides/config.md']);
  assert.equal(result.parentByPath.get('guides/start.md'), 'guides/guides.md');
  assert.deepEqual(result.pages[0].files, ['README.md']);
});

test('normalizePlan recognizes explicit landings and enforces the final hard cap', () => {
  const result = normalizePlan([
    { path: 'overview.md', title: 'Overview', files: ['README.md'] },
    { path: 'architecture/architecture.md', title: 'Architecture', files: ['lib/a.js'] },
    { path: 'architecture/a.md', title: 'A', files: ['lib/a.js'] },
    { path: 'architecture/b.md', title: 'B', files: ['lib/b.js'] },
    { path: 'guides/a.md', title: 'Guide A', files: ['README.md'] },
    { path: 'guides/b.md', title: 'Guide B', files: ['README.md'] },
  ], scan, { maxPages: 5 });

  assert.equal(result.pages.length, 5);
  assert.equal(result.pages.filter(p => p._landing).length, 1);
  assert.equal(result.pages.find(p => p._landing).path, 'architecture/architecture.md');
  assert.ok(
    result.pages.findIndex(p => p.path === 'architecture/architecture.md')
      > result.pages.findIndex(p => p.path === 'architecture/b.md')
  );
});

test('normalizePlan rejects plans without overview.md', () => {
  assert.throws(
    () => normalizePlan([{ path: 'guide.md', title: 'Guide', files: [] }], scan, { maxPages: 5 }),
    /overview\.md/
  );
});

test('groupPages returns stable directory groups', () => {
  const pages = [{ path: 'overview.md' }, { path: 'guides/a.md' }, { path: 'guides/b.md' }];
  assert.equal(dirOf('guides/a.md'), 'guides');
  assert.deepEqual([...groupPages(pages).keys()], ['', 'guides']);
});
