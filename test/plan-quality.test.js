'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previousPlanFromState,
  topicKeys,
  validatePlanQuality,
} = require('../lib/plan-quality');

test('rejects a page-count loss greater than 25 percent', () => {
  const previous = Array.from({ length: 15 }, (_, index) => ({
    path: index === 0 ? 'overview.md' : `guides/page-${index}.md`,
    title: index === 0 ? 'Project Overview' : `Guide ${index}`,
  }));
  const result = validatePlanQuality(previous.slice(0, 11), previous);

  assert.ok(result.violations.some(item => item.code === 'plan_page_regression'));
});

test('allows exactly 25 percent loss when topic coverage remains', () => {
  const previous = [
    { path: 'overview.md', title: 'Overview' },
    { path: 'page-a.md', title: 'Page A' },
    { path: 'page-b.md', title: 'Page B' },
    { path: 'page-c.md', title: 'Page C' },
  ];

  assert.equal(validatePlanQuality(previous.slice(0, 3), previous).ok, true);
});

test('rejects lost prior topic coverage', () => {
  const previous = [
    { path: 'overview.md', title: 'Overview' },
    { path: 'architecture/providers.md', title: 'AI Providers' },
  ];
  const next = [
    { path: 'overview.md', title: 'Overview' },
    { path: 'architecture/general.md', title: 'General Architecture' },
  ];
  const result = validatePlanQuality(next, previous);

  assert.deepEqual(result.violations
    .find(item => item.code === 'plan_topic_regression').topics, ['providers']);
});

test('acceptPlanShrink bypasses regression but not structure', () => {
  const previous = Array.from({ length: 8 }, (_, index) => ({
    path: index ? `page-${index}.md` : 'overview.md',
    title: `Page ${index}`,
  }));
  const singleton = [
    { path: 'overview.md', title: 'Overview' },
    { path: 'guides/only.md', title: 'Only Guide' },
  ];
  const result = validatePlanQuality(singleton, previous, {
    acceptPlanShrink: true,
  });

  assert.equal(result.violations.some(v => v.code === 'plan_page_regression'), false);
  assert.equal(result.violations.some(v => v.code === 'plan_singleton_directory'), true);
});

test('rejects landings with fewer than two children', () => {
  const child = { path: 'guides/start.md', title: 'Start' };
  const pages = [
    { path: 'overview.md', title: 'Overview' },
    child,
    {
      path: 'guides/guides.md',
      title: 'Guides',
      _landing: true,
      _children: [child],
    },
  ];
  const result = validatePlanQuality(pages, []);

  assert.ok(result.violations.some(item => item.code === 'plan_landing_children'));
  assert.ok(result.violations.some(item => item.code === 'plan_singleton_directory'));
});

test('accepts a directory with a landing and two children', () => {
  const children = [
    { path: 'guides/start.md', title: 'Start' },
    { path: 'guides/config.md', title: 'Configuration' },
  ];
  const result = validatePlanQuality([
    { path: 'overview.md', title: 'Overview' },
    ...children,
    {
      path: 'guides/guides.md',
      title: 'Guides',
      _landing: true,
      _children: children,
    },
  ], []);

  assert.equal(result.ok, true);
});

test('recovers the previous plan from state before catalog fallback', () => {
  const statePlan = [{ path: 'overview.md', title: 'State Overview' }];
  const catalogPlan = [{ path: 'overview.md', title: 'Catalog Overview' }];

  assert.deepEqual(previousPlanFromState({
    lastSuccessfulPlan: statePlan,
    pageMetadata: {},
  }, { pages: catalogPlan }), statePlan);
  assert.deepEqual(previousPlanFromState({
    pageMetadata: {
      'overview.md': { path: 'overview.md', title: 'Metadata Overview' },
    },
  }, { pages: catalogPlan }), [
    { path: 'overview.md', title: 'Metadata Overview' },
  ]);
  assert.deepEqual(previousPlanFromState({}, { pages: catalogPlan }), catalogPlan);
});

test('topicKeys produces stable semantic keys', () => {
  assert.deepEqual(topicKeys([
    { path: 'overview.md', title: 'Project Overview' },
    { path: 'architecture/providers.md', title: 'AI Providers' },
    { path: 'guides/exporting.md', title: 'Export to PDF' },
  ]), ['architecture', 'export', 'guides', 'overview', 'providers']);
});

test('flags source files absent from every page scope when a scan is supplied', () => {
  const scan = { fileSet: new Set(['README.md', 'lib/a.js', 'lib/b.js']) };
  const pages = [{ path: 'overview.md', title: 'Overview', files: ['README.md', 'lib/a.js'] }];
  const result = validatePlanQuality(pages, [], { scan });
  const violation = result.violations.find(item => item.code === 'plan_uncovered_files');
  assert.ok(violation);
  assert.deepEqual(violation.files, ['lib/b.js']);
  assert.equal(result.ok, false);
});

test('coverage gate passes when every source file is scoped', () => {
  const scan = { fileSet: new Set(['README.md', 'lib/a.js']) };
  const pages = [{ path: 'overview.md', title: 'Overview', files: ['README.md', 'lib/a.js'] }];
  assert.equal(validatePlanQuality(pages, [], { scan }).ok, true);
});

test('coverage gate is inert without a scan', () => {
  const pages = [{ path: 'overview.md', title: 'Overview', files: [] }];
  assert.equal(
    validatePlanQuality(pages, []).violations.some(item => item.code === 'plan_uncovered_files'),
    false
  );
});
