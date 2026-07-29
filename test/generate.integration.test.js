'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  createMockServer,
  defaultKnowledgeResponse,
} = require('./mock-llm');
const { parseRangeTarget } = require('../lib/citations');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runGenerator(repo, config, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      GENERATOR,
      repo,
      '--config',
      config,
      '--knowledge',
      '--concurrency',
      '1',
      ...extraArgs,
    ], {
      cwd: APP_DIR,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function physicalLineCount(text) {
  if (!text) return 0;
  const count = text.split('\n').length;
  return text.endsWith('\n') ? count - 1 : count;
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(root) };
  if (stat.isFile()) return { type: 'file', bytes: fs.readFileSync(root).toString('base64') };
  const entries = {};
  for (const name of fs.readdirSync(root).sort()) {
    entries[name] = snapshotTree(path.join(root, name));
  }
  return { type: 'directory', entries };
}

function snapshotWiki(repo) {
  const base = path.join(repo, '.local-wiki');
  return {
    content: snapshotTree(path.join(base, 'en/content')),
    meta: snapshotTree(path.join(base, 'en/meta')),
    knowledge: snapshotTree(path.join(base, 'knowledge/en')),
  };
}

function latestRunDir(repo) {
  const runs = path.join(repo, '.local-wiki/runs');
  const names = fs.readdirSync(runs).sort();
  assert.ok(names.length > 0, 'expected at least one diagnostics run');
  return path.join(runs, names.at(-1));
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

function transactionArtifacts(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (/\.stage-|\.backup-/.test(entry.name)) found.push(path.join(current, entry.name));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(path.join(current, entry.name));
      }
    }
  };
  visit(root);
  return found;
}

test('generator repairs, grounds, preserves last good pages, and skips unchanged sources', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-integration-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'lib'));
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# Demo\n\nA deterministic repository used to verify local wiki generation.\n'
  );
  writeJson(path.join(repo, 'package.json'), {
    name: 'demo',
    version: '1.0.0',
    dependencies: { demo: '1.0.0' },
  });
  fs.writeFileSync(
    path.join(repo, 'lib/a.js'),
    [
      "'use strict';",
      'function run() {',
      '  try {',
      "    console.log(process.env.DEMO_MODE || 'safe');",
      '    return true;',
      '  } catch (error) {',
      '    console.error(error);',
      '    throw error;',
      '  }',
      '}',
      'module.exports = { run };',
      '',
    ].join('\n')
  );
  fs.copyFileSync(path.join(repo, 'lib/a.js'), path.join(repo, 'lib/b.js'));
  writeJson(path.join(repo, 'config.json'), { mode: 'safe', retries: 2 });
  fs.writeFileSync(path.join(repo, 'guides.md'), 'Run the CLI with the repository path.\n');

  const plan = {
    pages: [
      {
        path: 'overview.md',
        title: 'Project Overview',
        description: 'Purpose, architecture, and core workflow.',
        files: ['README.md', 'package.json'],
      },
      {
        path: 'guides/start.md',
        title: 'Start',
        description: 'How to run the project.',
        files: ['README.md', 'lib/a.js'],
      },
      {
        path: 'guides/configuration.md',
        title: 'Configuration',
        description: 'How configuration is consumed.',
        files: ['config.json', 'lib/a.js'],
      },
    ],
  };
  const behavior = {
    rejectedOverview: false,
    alwaysFailTitle: null,
    failKnowledge: false,
    planSequence: null,
    finishReasonTitle: null,
  };
  const refusal = [
    '# Refused',
    '',
    'I apologize, but I cannot access the source files with the available file access tools.',
    'Please provide the source files before I continue with this documentation request.',
  ].join('\n');
  const server = createMockServer({
    plan,
    planResponder: ({ defaultPlan }) => {
      if (!behavior.planSequence) return defaultPlan;
      return behavior.planSequence.shift() || defaultPlan;
    },
    pageResponder: context => {
      if (behavior.alwaysFailTitle === context.title) return refusal;
      if (context.title === 'Project Overview'
        && !context.isRepair
        && !behavior.rejectedOverview) {
        behavior.rejectedOverview = true;
        return refusal;
      }
      return context.defaultResponse();
    },
    knowledgeResponder: context => {
      if (behavior.failKnowledge) return refusal;
      return defaultKnowledgeResponse(context);
    },
    finishReasonResponder: ({ kind, title }) => {
      if (kind === 'page' && behavior.finishReasonTitle === title) return 'length';
      return 'stop';
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const configPath = path.join(repo, 'repo-wiki.config.json');
  const mockConfig = {
    default: 'mock',
    language: 'en',
    maxPages: 5,
    template: 'standard',
    models: {
      mock: {
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'mock-model',
        contextChars: 24000,
        maxTokens: 4096,
      },
    },
  };
  writeJson(configPath, mockConfig);

  const contentDir = path.join(repo, '.local-wiki/en/content');
  const metaDir = path.join(repo, '.local-wiki/en/meta');
  const knowledgeDir = path.join(repo, '.local-wiki/knowledge/en');
  const traversalVictim = path.join(repo, 'traversal-victim.md');
  const linkedOutside = path.join(repo, 'linked-outside');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(linkedOutside);
  fs.writeFileSync(traversalVictim, 'must survive');
  fs.writeFileSync(path.join(linkedOutside, 'victim.md'), 'must also survive');
  fs.symlinkSync(linkedOutside, path.join(contentDir, 'linked'), 'dir');
  const traversalPath = path.relative(contentDir, traversalVictim);
  writeJson(path.join(metaDir, 'catalog.json'), {
    pages: [
      {
        path: traversalPath,
        title: 'Traversal victim',
      },
      {
        path: 'linked/victim.md',
        title: 'Symlink victim',
      },
    ],
  });
  writeJson(path.join(contentDir, '.state.json'), {
    pages: {
      [traversalPath]: 'untrusted-hash',
      'linked/victim.md': 'untrusted-hash',
    },
    pageMetadata: {},
  });

  const planRequestsBeforeInvalidFlags = server.state.planRequests;
  const invalidFlags = await runGenerator(repo, configPath, [
    '--pages',
    'overview.md',
    '--prune',
  ]);
  assert.equal(invalidFlags.code, 1);
  assert.match(invalidFlags.stderr, /--pages cannot be combined/);
  assert.equal(server.state.planRequests, planRequestsBeforeInvalidFlags);

  const first = await runGenerator(repo, configPath);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  assert.equal(server.state.repairRequests, 1);
  assert.equal(fs.readFileSync(traversalVictim, 'utf8'), 'must survive');
  assert.equal(
    fs.readFileSync(path.join(linkedOutside, 'victim.md'), 'utf8'),
    'must also survive'
  );

  const landingPath = path.join(contentDir, 'guides/guides.md');
  assert.equal(fs.existsSync(landingPath), true);
  const landing = fs.readFileSync(landingPath, 'utf8');
  assert.match(landing, /\[Start\]\(start\.md\)/);
  assert.match(landing, /\[Configuration\]\(configuration\.md\)/);

  const catalog = JSON.parse(fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8'));
  assert.equal(catalog.pages.length, 4);
  assert.equal(
    catalog.pages.find(page => page.path === 'guides/start.md').parent,
    'guides/guides.md'
  );
  assert.equal(
    catalog.pages.find(page => page.path === 'guides/guides.md').isLanding,
    true
  );

  for (const catalogPage of catalog.pages) {
    const markdown = fs.readFileSync(path.join(contentDir, catalogPage.path), 'utf8');
    const targets = [...markdown.matchAll(/\]\(([^)]+#L\d+-L\d+)\)/g)]
      .map(match => match[1]);
    if (!catalogPage.isLanding) assert.ok(targets.length > 0, catalogPage.path);
    for (const target of targets) {
      const range = parseRangeTarget(target);
      assert.ok(range, target);
      assert.ok(catalogPage.dependent_files.includes(range.path), target);
      const raw = fs.readFileSync(path.join(repo, range.path), 'utf8');
      assert.ok(range.start >= 1);
      assert.ok(range.end <= physicalLineCount(raw), target);
    }
  }

  const knowledgeIndex = fs.readFileSync(path.join(knowledgeDir, '_index.yaml'), 'utf8');
  assert.match(knowledgeIndex, /title: "Core Libraries"/);
  assert.match(knowledgeIndex, /title: "Core Libraries"[\s\S]*children: \[\]/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(knowledgeDir, '_manifest.json'), 'utf8')
  );
  assert.equal(new Set(manifest.files).size, manifest.files.length);
  assert.ok(manifest.files.includes('_index.yaml'));
  assert.ok(manifest.files.includes('lib/_module.yaml'));
  assert.ok(manifest.files.includes('topics/configuration_system.md'));
  assert.ok(manifest.files.includes('topics/error_handling.md'));
  assert.ok(manifest.files.includes('topics/logging_system.md'));
  assert.ok(manifest.files.includes('topics/dependency_management.md'));
  for (const relative of manifest.files.filter(file => file.endsWith('.md'))) {
    const card = fs.readFileSync(path.join(knowledgeDir, relative), 'utf8');
    assert.match(card, /^---\nkind: /, relative);
    assert.match(card, /\nsource_files:/, relative);
  }

  mockConfig.maxPages = 8;
  writeJson(configPath, mockConfig);
  plan.pages.push(
    {
      path: 'linked/one.md',
      title: 'Linked One',
      description: 'Must never write through a staged symlink.',
      files: ['README.md'],
    },
    {
      path: 'linked/two.md',
      title: 'Linked Two',
      description: 'Must never write through a staged symlink.',
      files: ['README.md'],
    }
  );
  const beforeUnsafePlan = snapshotWiki(repo);
  const outsideBeforeUnsafePlan = snapshotTree(linkedOutside);
  const unsafePlan = await runGenerator(repo, configPath);
  assert.equal(unsafePlan.code, 1, `${unsafePlan.stderr}\n${unsafePlan.stdout}`);
  assert.deepEqual(snapshotWiki(repo), beforeUnsafePlan);
  assert.deepEqual(snapshotTree(linkedOutside), outsideBeforeUnsafePlan);
  plan.pages.splice(-2);
  mockConfig.maxPages = 5;
  writeJson(configPath, mockConfig);

  const collapsedPlan = {
    pages: [{
      path: 'overview.md',
      title: 'Project Overview',
      description: 'A suspiciously collapsed plan.',
      files: ['README.md'],
    }],
  };
  behavior.planSequence = [collapsedPlan, plan];
  const repairedPlanRun = await runGenerator(repo, configPath);
  assert.equal(repairedPlanRun.code, 0, repairedPlanRun.stderr);
  assert.equal(server.state.lastPlanRunRequests, 2);

  const liveBeforeRejectedPlans = snapshotWiki(repo);
  behavior.planSequence = [collapsedPlan, collapsedPlan, collapsedPlan];
  const rejectedPlans = await runGenerator(repo, configPath);
  assert.equal(rejectedPlans.code, 1);
  assert.deepEqual(snapshotWiki(repo), liveBeforeRejectedPlans);
  assert.equal(server.state.lastPlanRunRequests, 3);
  const rejectedPlanDiagnostics = latestRunDir(repo);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(fs.existsSync(path.join(
      rejectedPlanDiagnostics,
      `plan/attempt-${attempt}.raw.txt`
    )), true);
  }
  const planAttempt = JSON.parse(fs.readFileSync(
    path.join(rejectedPlanDiagnostics, 'plan/attempt-3.json'),
    'utf8'
  ));
  assert.equal(planAttempt.finishReason, 'stop');
  assert.ok(planAttempt.violations.some(item => item.code === 'plan_page_regression'));
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(rejectedPlanDiagnostics, 'run.json'),
    'utf8'
  )).status, 'aborted');
  behavior.planSequence = null;

  const beforeKnowledgeFailure = snapshotWiki(repo);
  const pageRequestsBeforeKnowledgeFailure = server.state.pageRequests;
  behavior.failKnowledge = true;
  const failedKnowledge = await runGenerator(repo, configPath, ['--force']);
  assert.equal(failedKnowledge.code, 1, `${failedKnowledge.stderr}\n${failedKnowledge.stdout}`);
  assert.ok(server.state.pageRequests > pageRequestsBeforeKnowledgeFailure);
  assert.deepEqual(snapshotWiki(repo), beforeKnowledgeFailure);
  const failedKnowledgeRun = latestRunDir(repo);
  const failedKnowledgeSummary = JSON.parse(fs.readFileSync(
    path.join(failedKnowledgeRun, 'run.json'),
    'utf8'
  ));
  assert.equal(failedKnowledgeSummary.status, 'aborted');
  assert.ok(failedKnowledgeSummary.knowledgeFailures > 0);
  const knowledgeAttemptFile = filesUnder(path.join(failedKnowledgeRun, 'knowledge'))
    .find(file => file.endsWith('attempt-1.json'));
  assert.ok(knowledgeAttemptFile);
  const knowledgeAttempt = JSON.parse(fs.readFileSync(knowledgeAttemptFile, 'utf8'));
  assert.equal(knowledgeAttempt.finishReason, 'stop');
  assert.ok(knowledgeAttempt.violations.some(item => item.code === 'knowledge_refusal'));
  behavior.failKnowledge = false;

  const startPlan = plan.pages.find(page => page.path === 'guides/start.md');
  const startCallsBeforeIdentityChange = server.state.byTitle.Start;
  startPlan.files = ['README.md', 'lib/b.js'];
  const identityChange = await runGenerator(repo, configPath);
  assert.equal(identityChange.code, 0, `${identityChange.stderr}\n${identityChange.stdout}`);
  assert.equal(server.state.byTitle.Start, startCallsBeforeIdentityChange + 1);
  const identityPage = fs.readFileSync(
    path.join(contentDir, 'guides/start.md'),
    'utf8'
  );
  assert.match(identityPage, /\[lib\/b\.js\]\(lib\/b\.js\)/);
  assert.doesNotMatch(identityPage, /\[lib\/a\.js\]\(lib\/a\.js\)/);

  startPlan.title = 'Renamed Start';
  behavior.alwaysFailTitle = 'Renamed Start';
  const beforeFailedChildRename = snapshotWiki(repo);
  const failedChildRename = await runGenerator(repo, configPath);
  assert.equal(
    failedChildRename.code,
    1,
    `${failedChildRename.stderr}\n${failedChildRename.stdout}`
  );
  assert.deepEqual(snapshotWiki(repo), beforeFailedChildRename);
  assert.doesNotMatch(fs.readFileSync(landingPath, 'utf8'), /Renamed Start/);
  const failedRenameCatalog = JSON.parse(
    fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8')
  );
  assert.equal(
    failedRenameCatalog.pages.find(page => page.path === 'guides/start.md').title,
    'Start'
  );
  startPlan.title = 'Start';
  behavior.alwaysFailTitle = null;
  const restoreStart = await runGenerator(repo, configPath);
  assert.equal(restoreStart.code, 0, `${restoreStart.stderr}\n${restoreStart.stdout}`);

  plan.pages.push({
    path: 'guides/added.md',
    title: 'Added',
    description: 'A new child whose landing regeneration will fail.',
    files: ['README.md'],
  });
  behavior.alwaysFailTitle = 'Guides';
  const failedLanding = await runGenerator(repo, configPath);
  assert.equal(failedLanding.code, 1, `${failedLanding.stderr}\n${failedLanding.stdout}`);
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/added.md')), false);
  assert.doesNotMatch(fs.readFileSync(landingPath, 'utf8'), /Added|added\.md/);
  const failedLandingCatalog = JSON.parse(
    fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8')
  );
  assert.equal(
    failedLandingCatalog.pages.some(page => page.path === 'guides/added.md'),
    false
  );
  const failedLandingIndex = fs.readFileSync(path.join(contentDir, 'index.md'), 'utf8');
  assert.doesNotMatch(failedLandingIndex, /Added|added\.md/);
  plan.pages.pop();
  behavior.alwaysFailTitle = null;
  const removeAdded = await runGenerator(repo, configPath);
  assert.equal(removeAdded.code, 0, `${removeAdded.stderr}\n${removeAdded.stdout}`);

  plan.pages.push({
    path: 'guides/selective.md',
    title: 'Selective',
    description: 'A child generated through the page selector.',
    files: ['README.md'],
  });
  const selective = await runGenerator(
    repo,
    configPath,
    ['--pages', 'guides/selective.md']
  );
  assert.equal(selective.code, 0, `${selective.stderr}\n${selective.stdout}`);
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/selective.md')), true);
  assert.doesNotMatch(fs.readFileSync(landingPath, 'utf8'), /Selective|selective\.md/);
  const selectiveCatalog = JSON.parse(
    fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8')
  );
  assert.equal(
    selectiveCatalog.pages.find(page => page.path === 'guides/selective.md').parent,
    null
  );
  const selectiveIndex = fs.readFileSync(path.join(contentDir, 'index.md'), 'utf8');
  assert.match(selectiveIndex, /^- \[Selective]\(guides\/selective\.md\)$/m);
  assert.doesNotMatch(selectiveIndex, /^  - \[Selective]/m);
  plan.pages.pop();
  const removeSelective = await runGenerator(repo, configPath);
  assert.equal(removeSelective.code, 0, `${removeSelective.stderr}\n${removeSelective.stdout}`);
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/selective.md')), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8'))
      .pages.some(page => page.path === 'guides/selective.md'),
    true
  );
  const pruneSelective = await runGenerator(repo, configPath, ['--prune']);
  assert.equal(pruneSelective.code, 0, `${pruneSelective.stderr}\n${pruneSelective.stdout}`);
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/selective.md')), false);

  plan.pages.push({
    path: 'guides/broken.md',
    title: 'Broken',
    description: 'A newly planned page that must not be advertised if generation fails.',
    files: ['README.md'],
  });
  behavior.alwaysFailTitle = 'Broken';
  const newPageFailure = await runGenerator(repo, configPath);
  assert.equal(
    newPageFailure.code,
    1,
    `${newPageFailure.stderr}\n${newPageFailure.stdout}`
  );
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/broken.md')), false);
  const failedCatalog = JSON.parse(
    fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8')
  );
  assert.equal(
    failedCatalog.pages.some(page => page.path === 'guides/broken.md'),
    false
  );
  const failedIndex = fs.readFileSync(path.join(contentDir, 'index.md'), 'utf8');
  assert.doesNotMatch(failedIndex, /Broken|broken\.md/);
  assert.doesNotMatch(fs.readFileSync(landingPath, 'utf8'), /Broken|broken\.md/);
  plan.pages.pop();
  behavior.alwaysFailTitle = null;

  const protectedPage = path.join(contentDir, 'guides/start.md');
  const lastKnownGood = fs.readFileSync(protectedPage);
  fs.appendFileSync(path.join(repo, 'lib/b.js'), '// changed source\n');
  behavior.finishReasonTitle = 'Start';
  const repairCountBeforeFailure = server.state.repairRequests;
  const beforeTruncatedPage = snapshotWiki(repo);
  const failed = await runGenerator(repo, configPath);
  assert.equal(failed.code, 1, `${failed.stderr}\n${failed.stdout}`);
  assert.equal(server.state.repairRequests - repairCountBeforeFailure, 2);
  assert.deepEqual(fs.readFileSync(protectedPage), lastKnownGood);
  assert.deepEqual(snapshotWiki(repo), beforeTruncatedPage);
  assert.equal(
    fs.readdirSync(path.dirname(protectedPage)).some(name => name.includes('.tmp-')),
    false
  );
  const truncatedPageRun = latestRunDir(repo);
  const truncatedAttempt = JSON.parse(fs.readFileSync(
    path.join(truncatedPageRun, 'pages/guides/start/attempt-3.json'),
    'utf8'
  ));
  assert.equal(truncatedAttempt.finishReason, 'length');
  assert.ok(truncatedAttempt.violations.some(
    item => item.code === 'completion_truncated'
  ));

  behavior.finishReasonTitle = null;
  const recovered = await runGenerator(repo, configPath);
  assert.equal(recovered.code, 0, `${recovered.stderr}\n${recovered.stdout}`);
  const unchanged = await runGenerator(repo, configPath);
  assert.equal(unchanged.code, 0, `${unchanged.stderr}\n${unchanged.stdout}`);
  const skipped = unchanged.stdout.match(/\bSKIP\b/g) || [];
  assert.equal(skipped.length, catalog.pages.length, unchanged.stdout);

  behavior.planSequence = [collapsedPlan];
  const planRequestsBeforeAcceptedShrink = server.state.planRequests;
  const acceptedShrink = await runGenerator(repo, configPath, ['--accept-plan-shrink']);
  assert.equal(acceptedShrink.code, 0, `${acceptedShrink.stderr}\n${acceptedShrink.stdout}`);
  assert.equal(server.state.planRequests - planRequestsBeforeAcceptedShrink, 1);
  assert.equal(fs.existsSync(path.join(contentDir, 'overview.md')), true);
  assert.equal(fs.existsSync(path.join(contentDir, 'guides/configuration.md')), false);
  assert.deepEqual(transactionArtifacts(path.join(repo, '.local-wiki')), []);
  const finalState = JSON.parse(
    fs.readFileSync(path.join(contentDir, '.state.json'), 'utf8')
  );
  assert.equal(finalState.generationSchemaVersion, 3);
  assert.equal(finalState.lastSuccessfulPlan.length, 1);
  assert.ok(finalState.lastRunId);
});
