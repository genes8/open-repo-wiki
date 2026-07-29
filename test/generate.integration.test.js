'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');
const { parseRangeTarget } = require('../lib/citations');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runGenerator(repo, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      GENERATOR,
      repo,
      '--config',
      config,
      '--knowledge',
      '--concurrency',
      '1',
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
  };
  const refusal = [
    '# Refused',
    '',
    'I apologize, but I cannot access the source files with the available file access tools.',
    'Please provide the source files before I continue with this documentation request.',
  ].join('\n');
  const server = createMockServer({
    plan,
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
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const configPath = path.join(repo, 'repo-wiki.config.json');
  writeJson(configPath, {
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
  });

  const first = await runGenerator(repo, configPath);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  assert.equal(server.state.repairRequests, 1);

  const contentDir = path.join(repo, '.local-wiki/en/content');
  const metaDir = path.join(repo, '.local-wiki/en/meta');
  const knowledgeDir = path.join(repo, '.local-wiki/knowledge/en');
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
  behavior.alwaysFailTitle = 'Start';
  const repairCountBeforeFailure = server.state.repairRequests;
  const failed = await runGenerator(repo, configPath);
  assert.equal(failed.code, 1, `${failed.stderr}\n${failed.stdout}`);
  assert.equal(server.state.repairRequests - repairCountBeforeFailure, 2);
  assert.deepEqual(fs.readFileSync(protectedPage), lastKnownGood);
  assert.equal(
    fs.readdirSync(path.dirname(protectedPage)).some(name => name.includes('.tmp-')),
    false
  );

  behavior.alwaysFailTitle = null;
  const recovered = await runGenerator(repo, configPath);
  assert.equal(recovered.code, 0, `${recovered.stderr}\n${recovered.stdout}`);
  const unchanged = await runGenerator(repo, configPath);
  assert.equal(unchanged.code, 0, `${unchanged.stderr}\n${unchanged.stdout}`);
  const skipped = unchanged.stdout.match(/\bSKIP\b/g) || [];
  assert.equal(skipped.length, catalog.pages.length, unchanged.stdout);
});
