'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moduleMap, semanticModuleTitle } = require('../lib/modules');
const {
  buildKnowledgePlan,
  cardIdentity,
  cleanupManagedKnowledge,
  loadManifest,
  renderFrontmatter,
  safeManagedPath,
  validateKnowledgeContent,
  writeManifest,
} = require('../lib/knowledge');

test('semanticModuleTitle maps common directories and falls back predictably', () => {
  assert.equal(semanticModuleTitle('lib'), 'Core Libraries');
  assert.equal(semanticModuleTitle('tests'), 'Test Suite');
  assert.equal(semanticModuleTitle('custom-tools'), 'Custom Tools');
});

test('knowledge plan emits unique module cards and evidence-backed topics', () => {
  const files = [
    'config.json',
    'package.json',
    'lib/a.js',
    'tests/a.test.js',
  ];
  const scan = {
    name: 'demo',
    files: files.map(rel => ({ rel, size: 20 })),
    fileSet: new Set(files),
    keyFiles: {
      'package.json': '{"dependencies":{"demo":"1.0.0"}}',
    },
  };
  const evidence = {
    'config.json': '{"mode":"test"}',
    'package.json': '{"dependencies":{"demo":"1.0.0"}}',
    'lib/a.js': 'try { console.log(process.env.MODE); } catch (error) { throw error; }',
    'tests/a.test.js': 'console.error("failed")',
  };
  const modules = moduleMap(scan);
  const cardKinds = {
    overview: 'Overview focus',
    architecture_design: 'Architecture focus',
    tech_stack: 'Stack focus',
    coding_conventions: 'Conventions focus',
    unique_setup_and_commands: 'Setup focus',
  };

  const result = buildKnowledgePlan(scan, modules, cardKinds, evidence);
  const moduleCards = result.cards.filter(card => card.category === 'module');
  const topicCards = result.cards.filter(card => card.category === 'topic');

  assert.equal(moduleCards.length, modules.length * Object.keys(cardKinds).length);
  assert.deepEqual(topicCards.map(card => card.key), [
    'configuration',
    'error_handling',
    'logging',
    'dependency_management',
  ]);
  assert.equal(new Set(result.cards.map(cardIdentity)).size, result.cards.length);
  assert.equal(result.duplicates, 0);
  for (const card of topicCards) {
    assert.ok(card.source_files.length > 0);
    assert.ok(card.source_files.every(file => scan.fileSet.has(file)));
  }
  assert.equal(modules.find(module => module.key === 'lib').title, 'Core Libraries');
  assert.equal(modules.find(module => module.key === 'tests').title, 'Test Suite');
});

test('renderFrontmatter includes grounded card metadata', () => {
  const frontmatter = renderFrontmatter({
    kind: 'overview',
    category: 'module',
    name: 'Core Libraries Overview',
    scope: ['lib/**'],
    source_files: ['lib/a.js'],
  });

  assert.match(frontmatter, /^---\n/);
  assert.match(frontmatter, /kind: "overview"/);
  assert.match(frontmatter, /category: "module"/);
  assert.match(frontmatter, /name: "Core Libraries Overview"/);
  assert.match(frontmatter, /scope:\n  - "lib\/\*\*"/);
  assert.match(frontmatter, /source_files:\n  - "lib\/a\.js"/);
  assert.match(frontmatter, /---\n$/);
});

test('knowledge content rejects refusal and empty artifacts', () => {
  assert.equal(
    validateKnowledgeContent(
      'This grounded card explains configuration resolution using `config.json` and runtime environment values.'
    ).ok,
    true
  );
  assert.deepEqual(
    validateKnowledgeContent('I apologize, but I cannot access the files.').violations
      .map(item => item.code),
    ['knowledge_refusal']
  );
  assert.deepEqual(
    validateKnowledgeContent(
      'Please provide the source files so this knowledge card can be completed with repository evidence.'
    ).violations.map(item => item.code),
    ['knowledge_refusal']
  );
  assert.deepEqual(
    validateKnowledgeContent('').violations.map(item => item.code),
    ['knowledge_empty']
  );
  assert.equal(
    validateKnowledgeContent('_Not applicable for this module._').ok,
    true
  );
  assert.deepEqual(
    validateKnowledgeContent('Done.').violations.map(item => item.code),
    ['knowledge_too_short']
  );
});

test('manifest cleanup removes only stale managed files', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-knowledge-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'module'), { recursive: true });
  fs.writeFileSync(path.join(base, 'module/stale.md'), 'managed');
  fs.writeFileSync(path.join(base, 'module/current.md'), 'managed');
  fs.writeFileSync(path.join(base, 'personal-note.md'), 'unmanaged');

  const removed = cleanupManagedKnowledge(
    base,
    ['module/stale.md', 'module/current.md'],
    ['module/current.md']
  );
  writeManifest(base, ['module/current.md', 'module/current.md']);
  const manifest = loadManifest(base);

  assert.deepEqual(removed, ['module/stale.md']);
  assert.equal(fs.existsSync(path.join(base, 'module/stale.md')), false);
  assert.equal(fs.existsSync(path.join(base, 'module/current.md')), true);
  assert.equal(fs.existsSync(path.join(base, 'personal-note.md')), true);
  assert.deepEqual(manifest.files, ['module/current.md']);
});

test('manifest cleanup never follows a symlinked parent outside the knowledge root', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-knowledge-link-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = path.join(temp, 'knowledge');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(base);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'victim.md'), 'must survive');
  fs.symlinkSync(outside, path.join(base, 'linked'), 'dir');

  assert.equal(safeManagedPath(base, 'linked/victim.md'), null);
  const removed = cleanupManagedKnowledge(base, ['linked/victim.md'], []);

  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.md'), 'utf8'), 'must survive');
});
