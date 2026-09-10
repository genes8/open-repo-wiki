'use strict';

const { dirOf, coverageReport } = require('./plan');

const TOPICS = Object.freeze({
  overview: /\boverview\b/,
  architecture: /\barchitecture\b/,
  modules: /\bmodules?\b/,
  configuration: /\bconfig(?:uration)?\b/,
  testing: /\btests?|testing\b/,
  guides: /\bguides?\b/,
  reference: /\breference\b/,
  providers: /\bproviders?\b/,
  prompts: /\bprompts?\b/,
  scanning: /\bscan(?:ning|ner)?\b/,
  installation: /\binstall(?:ation|ing)?\b/,
  usage: /\busage|getting started\b/,
  export: /\bexport(?:ing)?\b/,
  deployment: /\bdeploy(?:ment|ing)?|\bci\b/,
});

function pageText(page) {
  return `${page && page.path || ''} ${page && page.title || ''}`
    .toLowerCase()
    .replace(/[_.\/-]+/g, ' ');
}

function topicKeys(pages) {
  const found = new Set();
  for (const page of Array.isArray(pages) ? pages : []) {
    const text = pageText(page);
    for (const [key, pattern] of Object.entries(TOPICS)) {
      if (pattern.test(text)) found.add(key);
    }
  }
  return [...found].sort();
}

function previousPlanFromState(state, catalog) {
  if (Array.isArray(state && state.lastSuccessfulPlan)) {
    return state.lastSuccessfulPlan;
  }
  const metadata = Object.values(state && state.pageMetadata || {});
  if (metadata.length) return metadata;
  return Array.isArray(catalog && catalog.pages) ? catalog.pages : [];
}

function validatePlanQuality(pages, previousPages, options = {}) {
  const violations = [];
  const next = Array.isArray(pages) ? pages : [];
  const previous = Array.isArray(previousPages) ? previousPages : [];

  if (!options.acceptPlanShrink && previous.length) {
    const minimum = Math.ceil(previous.length * 0.75);
    if (next.length < minimum) {
      violations.push({
        code: 'plan_page_regression',
        message: `plan has ${next.length} pages; previous ${previous.length}, minimum ${minimum}`,
      });
    }
    const nextTopics = new Set(topicKeys(next));
    const missing = topicKeys(previous).filter(key => !nextTopics.has(key));
    if (missing.length) {
      violations.push({
        code: 'plan_topic_regression',
        message: `plan lost prior topics: ${missing.join(', ')}`,
        topics: missing,
      });
    }
  }

  const byDir = new Map();
  for (const page of next) {
    const dir = dirOf(page.path);
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(page);
    if (page._landing && (page._children || []).length < 2) {
      violations.push({
        code: 'plan_landing_children',
        message: `landing ${page.path} has fewer than two children`,
        path: page.path,
      });
    }
  }
  for (const [dir, grouped] of byDir) {
    const children = grouped.filter(page => !page._landing);
    if (children.length === 1) {
      violations.push({
        code: 'plan_singleton_directory',
        message: `directory ${dir} contains one non-landing page`,
        path: children[0].path,
      });
    }
  }

  // Coverage is a first-class quality property: a plan that leaves real source
  // files out of every page scope silently drops modules from the wiki. Only
  // enforced when the caller supplies the scan; normalizePlan's deterministic
  // ensureFileCoverage normally satisfies this before validation runs, so this
  // gate is a safety net that also catches regressions in that repair.
  if (options.scan) {
    const coverage = coverageReport(next, options.scan, {
      extensions: options.coverageExtensions,
    });
    if (coverage.uncovered.length) {
      const shown = coverage.uncovered.slice(0, 8).join(', ');
      violations.push({
        code: 'plan_uncovered_files',
        message: `${coverage.uncovered.length} source file(s) in no page scope: ${shown}${
          coverage.uncovered.length > 8 ? ', ...' : ''
        }`,
        files: coverage.uncovered,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  TOPICS,
  previousPlanFromState,
  topicKeys,
  validatePlanQuality,
};
