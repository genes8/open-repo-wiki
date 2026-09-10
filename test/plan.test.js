'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePlan,
  dirOf,
  groupPages,
  coverageReport,
  ensureFileCoverage,
} = require('../lib/plan');

const scan = {
  fileSet: new Set(['README.md', 'lib/a.js', 'lib/b.js', 'config.json']),
};

test('normalizePlan filters paths/files and synthesizes one landing per grouped directory', () => {
  const result = normalizePlan([
    null,
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

test('hard-cap recomputation clears stale explicit landing metadata', () => {
  const result = normalizePlan([
    { path: 'overview.md', title: 'Overview', files: ['README.md'] },
    { path: 'guides/guides.md', title: 'Guides', files: ['README.md'] },
    { path: 'guides/a.md', title: 'A', files: ['lib/a.js'] },
    { path: 'guides/b.md', title: 'B', files: ['lib/b.js'] },
  ], scan, { maxPages: 2 });

  const formerLanding = result.pages.find(page => page.path === 'guides/guides.md');
  assert.equal(formerLanding._landing, undefined);
  assert.equal(formerLanding._children, undefined);
  assert.deepEqual([...result.parentByPath], []);
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

test('coverageReport lists source files absent from every page scope', () => {
  const report = coverageReport([
    { path: 'overview.md', files: ['README.md', 'lib/a.js'] },
  ], scan);
  // Only code files are coverable: lib/a.js and lib/b.js (not README.md/config.json).
  assert.deepEqual(report.coverable, ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(report.uncovered, ['lib/b.js']);
  assert.equal(report.total, 2);
  assert.equal(report.coveredCount, 1);
});

test('ensureFileCoverage assigns uncovered files to the closest page by directory', () => {
  const pages = [
    { path: 'overview.md', files: ['README.md'] },
    { path: 'architecture/modules.md', files: ['lib/a.js'] },
  ];
  const { assigned } = ensureFileCoverage(pages, scan);
  // lib/b.js shares the 'lib' directory with lib/a.js, so it lands on modules.md.
  assert.deepEqual(pages.find(p => p.path === 'architecture/modules.md').files, ['lib/a.js', 'lib/b.js']);
  // overview.md is untouched; assignment is append-only.
  assert.deepEqual(pages.find(p => p.path === 'overview.md').files, ['README.md']);
  assert.deepEqual(assigned, [{ file: 'lib/b.js', page: 'architecture/modules.md' }]);
  assert.equal(coverageReport(pages, scan).uncovered.length, 0);
});

test('ensureFileCoverage is idempotent and never reorders existing files', () => {
  const pages = [{ path: 'overview.md', files: ['lib/a.js'] }];
  ensureFileCoverage(pages, scan);
  const afterFirst = pages[0].files.slice();
  ensureFileCoverage(pages, scan);
  assert.deepEqual(afterFirst, ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(pages[0].files, afterFirst);
});

test('normalizePlan applies coverage only when ensureCoverage is set', () => {
  const raw = [{ path: 'overview.md', title: 'Overview', files: ['README.md', 'lib/a.js'] }];
  const off = normalizePlan(raw, scan, { maxPages: 5 });
  assert.deepEqual(off.pages[0].files, ['README.md', 'lib/a.js']);
  assert.equal(off.coverage, undefined);

  const on = normalizePlan(raw, scan, { maxPages: 5, ensureCoverage: true });
  assert.deepEqual(on.pages[0].files, ['README.md', 'lib/a.js', 'lib/b.js']);
  assert.deepEqual(on.coverage.assigned, [{ file: 'lib/b.js', page: 'overview.md' }]);
});
