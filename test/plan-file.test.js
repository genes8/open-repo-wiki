'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWikiPlan, parseWikiPlanYaml, parseWikiPlanJson } = require('../lib/plan-file');

const VALID = `# guidance for the wiki generator
version: 1

repowiki:
  template: "architecture"
  notes:
    - text: "Focus on business workflows"
      author: "enes"
    - text: "Target new engineers"
  documents:
    - title: "System Architecture Overview"
      goal: "Describe modules and interactions"
    - title: "Order System"
      goal: "Explain the order lifecycle"
      parent: "System Architecture Overview"
      hints: "Include the payment flow"

knowledgecard:
  notes:
    - text: "Focus on payment and order modules"

scope:
  include:
    - "src/**"
  exclude:
    - "**/test/**"
`;

test('parses the full schema', () => {
  const plan = parseWikiPlanYaml(VALID);
  assert.equal(plan.version, 1);
  assert.equal(plan.repowiki.template, 'architecture');
  assert.deepEqual(plan.repowiki.notes, [
    { text: 'Focus on business workflows', author: 'enes' },
    { text: 'Target new engineers', author: '' },
  ]);
  assert.equal(plan.repowiki.documents.length, 2);
  assert.equal(plan.repowiki.documents[1].parent, 'System Architecture Overview');
  assert.equal(plan.repowiki.documents[1].hints, 'Include the payment flow');
  assert.deepEqual(plan.scope, { include: ['src/**'], exclude: ['**/test/**'] });
  assert.deepEqual(plan.knowledgecard.notes, [{ text: 'Focus on payment and order modules', author: '' }]);
});

test('empty file yields an empty normalized plan', () => {
  const plan = parseWikiPlanYaml('# nothing\n\n');
  assert.deepEqual(plan, {
    version: 1,
    repowiki: { template: '', notes: [], documents: [] },
    knowledgecard: { notes: [] },
    scope: { include: [], exclude: [] },
  });
});

test('list shorthand [] is accepted', () => {
  const plan = parseWikiPlanYaml('version: 1\nscope:\n  include: []\n  exclude: []\n');
  assert.deepEqual(plan.scope, { include: [], exclude: [] });
});

test('unknown top-level key is rejected with a line number', () => {
  assert.throws(() => parseWikiPlanYaml('version: 1\nbogus: 1\n'), /line 2.*bogus/);
});

test('invalid template value is rejected', () => {
  assert.throws(() => parseWikiPlanYaml('version: 1\nrepowiki:\n  template: fancy\n'), /template/);
});

test('version must be 1', () => {
  assert.throws(() => parseWikiPlanYaml('version: 2\n'), /version/);
});

test('version must be exactly 1 (integer or yaml string), not coercions', () => {
  assert.throws(() => parseWikiPlanJson('{"version":true}'), /version/);
  assert.throws(() => parseWikiPlanYaml('version: 01\n'), /version/);
  assert.throws(() => parseWikiPlanYaml('version: 1.0\n'), /version/);
  assert.doesNotThrow(() => parseWikiPlanYaml('version: 1\n'));
  assert.doesNotThrow(() => parseWikiPlanJson('{"version":1}'));
});

test('tabs are rejected', () => {
  assert.throws(() => parseWikiPlanYaml('version: 1\nscope:\n\tinclude: []\n'), /tab/i);
});

test('loadWikiPlan prefers yaml, accepts json, returns null when absent', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-plan-'));
  assert.equal(loadWikiPlan(repo), null);
  fs.writeFileSync(path.join(repo, 'wiki_plan.json'), JSON.stringify({
    version: 1, repowiki: { notes: [{ text: 'from json' }] },
  }));
  assert.equal(loadWikiPlan(repo).repowiki.notes[0].text, 'from json');
  fs.writeFileSync(path.join(repo, 'wiki_plan.yaml'), 'version: 1\nrepowiki:\n  notes:\n    - text: from yaml\n');
  assert.equal(loadWikiPlan(repo).repowiki.notes[0].text, 'from yaml');
});
