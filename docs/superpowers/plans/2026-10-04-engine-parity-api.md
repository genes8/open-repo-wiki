# Engine Parity + Programmatic API Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine full Qoder Repo Wiki parity (wiki_plan config, modify/supplement/rewrite, manual-edit protection, update/sync) behind a programmatic API with an NDJSON event stream, keeping the CLI behavior and the zero-dependency constraint.

**Architecture:** Extract `generate.js` orchestration into `lib/api.js` emitting typed events through `lib/events.js` (human + NDJSON reporters). Add `lib/plan-file.js` (strict YAML-subset + JSON plan config), `lib/scope-filter.js` (include/exclude), dual-hash page protection in state, and a `modifyWiki` operation. `generate.js` stays the CLI entry — behavior unchanged for existing flags.

**Tech Stack:** Node ≥18, CommonJS, node:test + node:assert/strict, zero runtime deps. Mock LLM server pattern from `test/mock-llm.js` + `test/config.json` for integration tests.

**Spec:** `docs/superpowers/specs/2026-10-04-vscode-extension-parity-design.md`

**Worktree:** execute in a dedicated worktree (see using-git-worktrees). Base branch: `main`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `lib/events.js` | Create | Typed event bus + human reporter + NDJSON reporter |
| `lib/api.js` | Create | `generateWiki`, `modifyWiki`, `loadRunConfig` orchestration (moved from generate.js) |
| `generate.js` | Rewrite thin | CLI arg parsing, reporter selection, exit codes |
| `lib/plan-file.js` | Create | Strict YAML-subset parser + `wiki_plan.json` alt + schema validation |
| `lib/scope-filter.js` | Create | gitignore-style include/exclude applied to a scan |
| `lib/scan.js` | Modify | Export `buildTree` and `buildLangStats` helpers |
| `lib/plan.js` | Modify | Add `planFromDocuments` (strict documents mode) |
| `lib/prompts.js` | Modify | `assignFilesMessages`, `modifyPageMessages`, notes/template injection |
| `test/events.test.js`, `test/plan-file.test.js`, `test/scope-filter.test.js`, `test/plan-strict-documents.test.js` | Create | Unit tests |
| `test/api-protection.integration.test.js`, `test/api-modify.integration.test.js`, `test/api-json-events.integration.test.js` | Create | Integration tests (mock server) |
| `wiki-plan.schema.md`, `README.md` | Modify | Documentation |

Conventions: every new lib file starts with `'use strict';` and ends with `module.exports`. Tests use `node:test` + `node:assert/strict`. Run a single suite with `node --test <file>`; run all with `npm test`. Commit after every green task (Conventional Commits).

---

### Task 1: Event bus + reporters (`lib/events.js`)

**Files:**
- Create: `lib/events.js`
- Test: `test/events.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventBus, createHumanReporter, createNdjsonReporter } = require('../lib/events');

test('createEventBus delivers every emit as an event with type and ts', () => {
  const { bus, emit } = createEventBus();
  const seen = [];
  bus.on('event', e => seen.push(e));
  emit('run_started', { model: 'mock' });
  emit('page_done', { path: 'overview.md', status: 'generated' });
  assert.deepEqual(seen.map(e => e.type), ['run_started', 'page_done']);
  assert.equal(seen[0].model, 'mock');
  assert.ok(typeof seen[0].ts === 'string' && seen[0].ts.length > 0);
});

test('ndjson reporter writes one JSON object per line', () => {
  const lines = [];
  const report = createNdjsonReporter(line => lines.push(line));
  report({ type: 'run_started', ts: '2026-10-04T00:00:00Z', model: 'mock' });
  report({ type: 'page_done', ts: '2026-10-04T00:00:01Z', path: 'a.md', status: 'generated' });
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'run_started', ts: '2026-10-04T00:00:00Z', model: 'mock' });
  assert.equal(JSON.parse(lines[1]).status, 'generated');
});

test('human reporter maps page statuses to the CLI labels', () => {
  const out = [];
  const report = createHumanReporter(line => out.push(line));
  report({ type: 'page_done', path: 'overview.md', status: 'generated', chars: 100, files: 2 });
  report({ type: 'page_done', path: 'a.md', status: 'protected', reason: 'externally-modified' });
  report({ type: 'page_fail', path: 'b.md', message: 'boom' });
  assert.deepEqual(out, [
    '  OK    overview.md (100 chars, 2 source files)',
    '  SKIP  a.md (protected: externally-modified)',
    '  FAIL  b.md: boom',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — `Cannot find module '../lib/events'`

- [ ] **Step 3: Implement `lib/events.js`**

```js
'use strict';
/**
 * Typed run-event plumbing for the wiki engine. api.js emits structured
 * events; reporters render them for humans (CLI default) or as NDJSON
 * (--json-events, consumed by the VSCode extension / other tools).
 */
const { EventEmitter } = require('node:events');

function createEventBus() {
  const bus = new EventEmitter();
  const emit = (type, payload = {}) => {
    bus.emit('event', { type, ts: new Date().toISOString(), ...payload });
  };
  return { bus, emit };
}

// Exact strings the CLI printed before extraction; tests and users rely on them.
function createHumanReporter(log = line => console.log(line)) {
  const statusLabel = {
    generated: (e) => `  OK    ${e.path} (${e.chars} chars, ${e.files} source files)`,
    degraded: (e) => `  WARN  ${e.path}: published degraded after 3 attempts (${e.codes})`,
    protected: (e) => `  SKIP  ${e.path} (protected: ${e.reason || 'curated'})`,
    skipped: (e) => `  SKIP  ${e.path} (${e.reason || 'unchanged'})`,
  };
  return (event) => {
    switch (event.type) {
      case 'run_started':
        log(`Repo:   ${event.repo}`);
        log(`Model:  ${event.model} (${event.provider}: ${event.modelId})`);
        log(`Config: ${event.configPath}`);
        log(`Out:    ${event.outDir}\n`);
        break;
      case 'env_loaded': log(`  loaded .env (${event.count} var${event.count === 1 ? '' : 's'})`); break;
      case 'scan_done': log(`  ${event.files} files considered\n`); break;
      case 'scan_warning': log(`  WARN  ${event.message}`); break;
      case 'plan_started': log('Planning wiki structure...'); break;
      case 'plan_retry': log(`  REPAIR plan attempt ${event.attempt}/2 (${event.codes})`); break;
      case 'plan_ready':
        log(`  ${event.pages.length} pages planned:`);
        for (const p of event.pages) log(`    - ${p.path}  (${p.title})`);
        if (event.coverage) log(`  coverage: attached ${event.coverage} otherwise-undocumented source file(s) to pages`);
        break;
      case 'dry_run': log('\nDry run — no pages written.'); break;
      case 'page_start': log(`  GEN   ${event.path} ...`); break;
      case 'page_retry': log(`  REPAIR ${event.path} attempt ${event.attempt}/2 (${event.codes})`); break;
      case 'page_note': log(`  note  ${event.path}: ${event.message}`); break;
      case 'page_done': log(statusLabel[event.status](event)); break;
      case 'page_fail': log(`  FAIL  ${event.path}: ${String(event.message).split('\n')[0]}`); break;
      case 'stale_removed': log(`  removed stale: ${event.path}`); break;
      case 'catalog_written': log(`  catalog + index staged -> ${event.metaDir}`); break;
      case 'knowledge_started': log('\nGenerating knowledge cards...'); break;
      case 'knowledge_card_fail': log(`  FAIL  ${event.path}: ${String(event.message).split('\n')[0]}`); break;
      case 'knowledge_done':
        log(`  knowledge: ${event.generated} cards written, ${event.duplicates} duplicates skipped, `
          + `${event.removed} stale removed -> ${event.dir}`);
        break;
      case 'knowledge_failed_run': log(`  knowledge: ${event.failed} failed; staged run will be discarded`); break;
      case 'run_aborted':
        log(`\nAborted: ${event.ok} staged, ${event.skipped} skipped, ${event.failed} ${event.subject} failures; live wiki unchanged`);
        break;
      case 'run_finished':
        log(`\nDone: ${event.stats.generated} generated, ${event.stats.degraded} degraded, `
          + `${event.stats.skipped} skipped, ${event.stats.failed} page failures, `
          + `${event.stats.knowledgeFailed} knowledge failures -> ${event.outDir}`);
        log(event.tip);
        break;
      case 'cleanup_warning': log(`  WARN  backup cleanup (${event.target}): ${event.message}`); break;
      default: break; // unknown events are ignored by the human reporter
    }
  };
}

function createNdjsonReporter(write = chunk => process.stdout.write(chunk)) {
  return (event) => { write(`${JSON.stringify(event)}\n`); };
}

module.exports = { createEventBus, createHumanReporter, createNdjsonReporter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/events.js test/events.test.js
git commit -m "feat: add typed run-event bus with human and NDJSON reporters"
```

---

### Task 2: Extract orchestration into `lib/api.js`

This is a mechanical, behavior-preserving move. The existing integration suite (`test/generate.integration.test.js`, spawns `generate.js` with the mock server) is the safety net — it must pass unchanged before and after.

**Files:**
- Create: `lib/api.js`
- Rewrite: `generate.js` (thin CLI)
- Existing tests stay green: `test/generate.integration.test.js`

- [ ] **Step 1: Run the existing integration suite as a baseline**

Run: `npm test`
Expected: PASS. Note the count — every task after this must keep it green. If any test is flaky, stop and report before proceeding.

- [ ] **Step 2: Create `lib/api.js` skeleton with options normalization**

Move from `generate.js`: `loadDotenv`, `loadConfig`, `pickProfile`, `listModels`, `sha1`, `unwrapMarkdown`, `atomicWrite`, `canonicalRelativePath`, `normalizePublishedMetadata`, `metadataFromCatalog`, `snapshotPageMetadata`, `collectKnowledgeEvidence`, `newRunId`, `planSnapshot`, `pruneEmptyDirectories`, `completionWasTruncated`, plus the whole IIFE body (current lines ~344–1156: from `(async () => {` through the final catch handler).

New public surface (complete file skeleton — the moved code slots in where marked):

```js
'use strict';
/**
 * Programmatic wiki engine API. Everything the CLI does is available here as
 * Promise-based functions emitting typed events (see lib/events.js). The CLI
 * and the VSCode extension's engine-entry both call these.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scanRepo } = require('./scan');
const { chatDetailed, resolveApiKey } = require('./providers');
const { createEventBus } = require('./events');
// ... all other requires now at top of generate.js (prompts, modules, citations,
// plan, sources, quality, plan-quality, run-diagnostics, run-transaction,
// output-layout, knowledge) move here unchanged.

const GENERATION_SCHEMA_VERSION = 3;

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// --- moved helpers (loadDotenv, loadConfig, pickProfile, sha1, ...) go here ---

// Normalize CLI-ish options into one place. Accepts both flag names from the
// CLI and camelCase from programmatic callers.
function normalizeOptions(options = {}) {
  return {
    model: options.model || null,
    out: options.out || null,
    configPath: options.config || options.configPath || null,
    pages: options.pages || null,
    concurrency: options.concurrency || null,
    template: options.template || null,
    knowledge: !!options.knowledge,
    force: !!options.force,
    dryRun: !!options.dryRun,
    prune: !!options.prune,
    acceptPlanShrink: !!options.acceptPlanShrink,
  };
}

async function generateWiki(repoDir, options = {}, onEvent = () => {}) {
  const opts = normalizeOptions(options);
  const { emit } = createEventBus();
  const forward = (event) => { onEvent(event); };
  // subscribe: bus.on('event', forward) — createEventBus returns { bus, emit }
  // --- moved IIFE body goes here, with the console substitution table below ---
}

async function modifyWiki(repoDir, options = {}, onEvent = () => {}) {
  // Added in Task 7. For now:
  throw new ApiError('not_implemented', 'modifyWiki lands in Task 7');
}

module.exports = { generateWiki, modifyWiki, ApiError, loadConfig, loadDotenv, pickProfile, listModels, GENERATION_SCHEMA_VERSION };
```

Wire the bus correctly inside `generateWiki`:

```js
const { bus, emit } = createEventBus();
bus.on('event', onEvent);
```

- [ ] **Step 3: Apply the console→event substitution table to the moved body**

Every `console.log`/`console.error`/`console.warn` in the moved code becomes an `emit`. Replace exactly:

| Old line (search anchor) | Replacement emit |
|---|---|
| `console.log(\`Repo:   ${repoDir}\`)` + Model/Config/Out block (4 lines) | `emit('run_started', { repo: repoDir, model: modelName, provider: profile.provider, modelId: profile.model \|\| profile.modelPath, configPath, outDir: liveOutDir })` |
| `console.log(\`  loaded .env (...)\`)` in loadDotenv | `emit('env_loaded', { count: loaded })` — loadDotenv gains an optional `onEvent` param; api passes `emit` |
| `console.log('Scanning repository...')` | `emit('scan_started', {})` |
| `console.log(\`  ${scan.files.length} files considered\n\`)` | `emit('scan_done', { files: scan.files.length })` |
| `console.log(\`  ${pages.length} pages planned:\`)` + the `- path (title)` loop + coverage note | `emit('plan_ready', { pages: pages.map(p => ({ path: p.path, title: p.title })), coverage: normalized.coverage && normalized.coverage.assigned.length \|\| 0 })` |
| `console.log(\`  REPAIR plan attempt ...\`)` | `emit('plan_retry', { attempt, codes })` |
| `console.log('\nDry run — no pages written.')` | `emit('dry_run', {})` then `return { dryRun: true }` (no process.exit) |
| `console.log(\`  GEN   ${page.path} ...\`)` | `emit('page_start', { path: page.path })` |
| `console.log(\`  SKIP  ${page.path} (unchanged)\`)` | `emit('page_done', { path: page.path, status: 'skipped', reason: 'unchanged' })` |
| `console.log(\`  note  ${page.path}: ...\`)` (3 sites: citation repaired, dropped, landing children) | `emit('page_note', { path: page.path, message })` |
| `console.log(\`  REPAIR ${page.path} attempt ...\`)` | `emit('page_retry', { path: page.path, attempt, codes })` |
| `console.log(\`  OK    ${page.path} (...)\`)` | `emit('page_done', { path: page.path, status: 'generated', chars: md.length, files: attached.length })` |
| `console.log(\`  WARN  ${page.path}: published degraded...\`)` | `emit('page_done', { path: page.path, status: 'degraded', codes })` |
| `console.log(\`  FAIL  ${page.path}: ...\`)` (2 sites: unsafe path, catch) | `emit('page_fail', { path: page.path, message: err.message })` |
| `console.log(\`  removed stale: ...\`)` | `emit('stale_removed', { path: managed.rel })` |
| `console.log(\`  catalog + index staged -> ...\`)` | `emit('catalog_written', { metaDir: path.relative(repoDir, liveMetaDir) })` |
| `console.log('\nGenerating knowledge cards...')` | `emit('knowledge_started', {})` |
| knowledge `FAIL` line | `emit('knowledge_card_fail', { path: card.relativePath, message: err.message })` |
| `knowledge: N cards written...` | `emit('knowledge_done', { generated: knowledgeGenerated, duplicates: knowledgePlan.duplicates, removed: removed.length, dir: path.relative(repoDir, liveKnowledgeBase) })` |
| `knowledge: N failed; staged run discarded` | `emit('knowledge_failed_run', { failed: knowledgeFailed })` |
| `console.log(\`  concurrency: ...\`)` | `emit('run_note', { message: \`concurrency: ${concurrency}\` })` |
| final `Done: ...` + Tip lines | `emit('run_finished', { stats: { generated: ok, degraded, skipped, failed, knowledgeFailed }, outDir: liveOutDir, tip: \`export to PDF with: node ${path.join(__dirname, '..', 'export.js')} ${liveOutDir} ${path.join(repoDir, 'wiki-pdf')}\` })` then `return { stats, catalog }` |
| both `Aborted: ...` blocks | `emit('run_aborted', { ok, skipped, failed, subject: 'page'\|'knowledge' })` then `throw new ApiError('page_failures'\|'knowledge_failures', message)` |
| `console.warn(\`  WARN  backup cleanup ...\`)` | `emit('cleanup_warning', { target, message })` |
| fatal-catch `console.error(\`Fatal: ...\`)` | `throw new ApiError('fatal', err.message)` after the existing transaction-abort + diagnostics-finish logic |
| plan-failed block (`Plan failed after 3 attempts`) | diagnostics.finish('aborted', ...) stays, then `throw new ApiError('plan_failed', message)` |
| `No readable source files found` | `throw new ApiError('no_files', 'No readable source files found — nothing to document.')` |
| `--pages cannot be combined...` / `Repository directory not found` / config/model errors | keep `process.exit`? NO — these become `throw new ApiError('bad_args', msg)`; the CLI catches and exits |

`process.exit(0)` sites (help, listModels, dry-run) disappear from api.js — they become returns; the CLI handles exit codes. Keep module-level `let activeTransaction/activeDiagnostics/publicationCommitted` INSIDE `generateWiki` as closure variables (the fatal catch becomes a try/catch wrapping the body).

- [ ] **Step 4: Rewrite `generate.js` as the thin CLI (complete new content)**

```js
#!/usr/bin/env node
/**
 * CLI entry for the local Repo Wiki generator. All orchestration lives in
 * lib/api.js; this file parses arguments, picks a reporter (human or NDJSON),
 * and maps ApiError codes to exit codes.
 */
const path = require('path');
const {
  generateWiki,
  modifyWiki,
  loadConfig,
  loadDotenv,
  listModels,
  ApiError,
} = require('./lib/api');
const { createHumanReporter, createNdjsonReporter } = require('./lib/events');

const HELP = `Local Repo Wiki generator

Usage: node generate.js [repoDir] [options]

Options:
  -m, --model <name>    model profile from config (default: config "default")
  -o, --out <dir>       output dir (default: <repoDir>/.local-wiki/en/content)
  -c, --config <file>   config file (default: <repoDir>/repo-wiki.config.json,
                        then <appDir>/config.json)
      --pages <substr>  only (re)generate pages whose path contains substring
      --concurrency <n> pages generated in parallel (default: profile/config, else 1)
      --template <name> page template: "standard" (citations + TOC) or "minimal"
      --knowledge       also generate the structured knowledge-card layer
      --force           regenerate everything, ignore the incremental cache
      --dry-run         print the wiki plan and exit without writing pages
      --prune           delete managed pages omitted by a successful,
                        non-regressive full plan
      --accept-plan-shrink
                        accept a regressive plan and delete omitted managed pages
      --json-events     machine mode: NDJSON events on stdout instead of human logs
      --modify <path>   modify an existing page (see --op); pairs with --instruction
      --op <name>       operation for --modify: modify | supplement | rewrite
      --instruction <text>
                        instruction describing the desired change (required with --modify)
      --list-models     list configured model profiles and exit
  -h, --help            show this help

Environment: REPO_WIKI_MODEL overrides the default model profile.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--pages') args.pages = argv[++i];
    else if (a === '--concurrency') args.concurrency = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--knowledge') args.knowledge = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--accept-plan-shrink') args.acceptPlanShrink = true;
    else if (a === '--json-events') args.jsonEvents = true;
    else if (a === '--modify') args.modify = argv[++i];
    else if (a === '--op') args.op = argv[++i];
    else if (a === '--instruction') args.instruction = argv[++i];
    else if (a === '--list-models') args.listModels = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (args.pages && (args.prune || args.acceptPlanShrink)) {
    console.error('--pages cannot be combined with --prune or --accept-plan-shrink');
    process.exit(1);
  }
  const repoDir = path.resolve(args._[0] || process.cwd());
  if (require('fs').existsSync(repoDir) && !require('fs').statSync(repoDir).isDirectory()) {
    console.error(`Repository directory not found: ${repoDir}`);
    process.exit(1);
  }

  const report = args.jsonEvents
    ? createNdjsonReporter()
    : createHumanReporter();

  if (args.listModels) {
    loadDotenv(repoDir);
    const { config } = loadConfig(args, repoDir);
    if (args.jsonEvents) {
      for (const [name, p] of Object.entries(config.models || {})) {
        report({ type: 'model_profile', name, default: name === config.default, provider: p.provider, model: p.model || p.modelPath || null });
      }
    } else {
      listModels(config);
    }
    process.exit(0);
  }

  try {
    if (args.modify) {
      await modifyWiki(repoDir, args, report);
    } else {
      await generateWiki(repoDir, args, report);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ApiError || err.code) {
      if (!args.jsonEvents) console.error(`Fatal: ${err.message}`);
      else report({ type: 'run_error', code: err.code || 'fatal', message: err.message });
    } else {
      if (!args.jsonEvents) console.error(`Fatal: ${err.message}`);
      else report({ type: 'run_error', code: 'fatal', message: err.message });
    }
    process.exit(1);
  }
})();
```

Note: the repoDir existence check moves to the top of `generateWiki` too (throw `ApiError('bad_args')`); the CLI keeps a fast pre-check only for the directory-not-a-directory case shown above — remove the duplicate once api.js owns it (keep the CLI check, delete the IIFE's copy).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — same count as the baseline in Step 1. Also run manually: `node generate.js --help` (prints HELP, exit 0) and `node generate.js . --dry-run` against a real config.

- [ ] **Step 6: Commit**

```bash
git add generate.js lib/api.js
git commit -m "refactor: extract engine orchestration into lib/api.js with event stream"
```

---

### Task 3: Dual-hash manual-edit protection

**Files:**
- Modify: `lib/api.js` (state handling, `snapshotPageMetadata`, `normalizePublishedMetadata`)
- Test: `test/api-protection.integration.test.js`

- [ ] **Step 1: Write the failing integration test**

Follow `test/generate.integration.test.js` patterns: `createMockServer()` from `test/mock-llm.js`, temp repo fixture with a few `.js` files, `runGenerator(repo, config)` helper (copy the spawn helper).

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');
const CONFIG = path.join(__dirname, 'config.json');

function runGenerator(repo, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, repo, '--config', CONFIG, ...extraArgs], {
      cwd: APP_DIR, env: { ...process.env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-protect-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"protect-fixture","version":"1.0.0"}\n');
  return repo;
}

test('externally edited page is protected, not clobbered, when its sources change', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    const first = await runGenerator(repo);
    assert.equal(first.code, 0, first.stderr);

    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    const original = fs.readFileSync(pageFile, 'utf8');
    const humanEdit = original.replace(/^# /m, '# HUMAN-EDITED ');
    fs.writeFileSync(pageFile, humanEdit);

    // change a source the page depends on -> input hash drifts
    const dep = target.dependent_files[0] || 'a.js';
    fs.appendFileSync(path.join(repo, dep), '\n// drift\n');

    const second = await runGenerator(repo);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /protected: externally-modified/);
    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(after.startsWith('# HUMAN-EDITED'), 'human edit must survive regeneration');
    assert.ok(!after.includes('GEN'), 'page must not be a fresh generation');

    const catalog2 = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const meta2 = catalog2.pages.find(p => p.path === target.path);
    assert.equal(meta2.protected, true, 'catalog marks the page as protected');
  } finally {
    await server.stop();
  }
});

test('--force overwrites an externally edited page', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    assert.equal((await runGenerator(repo)).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    fs.writeFileSync(pageFile, fs.readFileSync(pageFile, 'utf8').replace(/^# /m, '# HUMAN-EDITED '));
    const forced = await runGenerator(repo, ['--force']);
    assert.equal(forced.code, 0, forced.stderr);
    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(!after.startsWith('# HUMAN-EDITED'), '--force regenerates over the human edit');
  } finally {
    await server.stop();
  }
});
```

If the mock server needs page-specific responses to produce distinct pages per source group, extend `test/mock-llm.js` the way existing integration tests do (read that file first and follow its dispatch pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-protection.integration.test.js`
Expected: FAIL — stdout has no `protected: externally-modified`, human edit is overwritten.

- [ ] **Step 3: Implement protection in `lib/api.js`**

1. `snapshotPageMetadata(page, attached)` gains a third param and callers pass the published content: `snapshotPageMetadata(page, attached, outputHash = null)` returns `{ ..., outputHash, curated: page._curated === true }`.

2. `normalizePublishedMetadata(value, fallbackPath)` passes through the new fields:

```js
outputHash: typeof value.outputHash === 'string' ? value.outputHash : null,
curated: value.curated === true,
externallyModified: value.externallyModified === true,
```

3. At both write sites in `processPage` (ok + degraded) compute and store:

```js
const content = `${md.trim()}\n`;          // or best.md for degraded
atomicWrite(outFile, content);
const outputHash = sha1(content);
const publishedMetadata = { ...currentMetadata, outputHash };
state.pageMetadata[page.path] = publishedMetadata;
```

4. Insert the protection check in `processPage` right after the `--pages` filter block and BEFORE the unchanged-skip:

```js
const liveContent = fs.existsSync(outFile) ? sha1(fs.readFileSync(outFile, 'utf8')) : null;
const priorMeta = existingMetadata;
const outputMismatch = !!(priorMeta && priorMeta.outputHash && liveContent
  && priorMeta.outputHash !== liveContent);
const inputChanged = args.force || state.pages[page.path] !== hash || !fs.existsSync(outFile);
const protectedReason = priorMeta && (priorMeta.curated || outputMismatch)
  ? (priorMeta.curated ? 'curated' : 'externally-modified')
  : null;
if (protectedReason && inputChanged && !args.force) {
  page._publishedMetadata = { ...priorMeta, externallyModified: outputMismatch || priorMeta.externallyModified };
  page._published = true;
  page._protected = true;
  state.pageMetadata[page.path] = page._publishedMetadata; // outputHash stays = ours
  skipped++;
  emit('page_done', { path: page.path, status: 'protected', reason: protectedReason });
  return;
}
if (!inputChanged) {
  // unchanged skip — but surface external edits as a note (Sync detection)
  if (outputMismatch) emit('page_note', { path: page.path, message: 'externally modified by a human; left untouched' });
  ...existing skip code...
}
```

`outFile` is the staged copy (the transaction seeded it from live), so its content equals the human edit — the check works before any writes.

5. Catalog: when building `catalog.pages`, add `protected: metadata.curated === true || metadata.externallyModified === true`.

- [ ] **Step 4: Run the protection test and the full suite**

Run: `node --test test/api-protection.integration.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/api.js test/api-protection.integration.test.js test/mock-llm.js
git commit -m "feat: protect manually edited pages from incremental regeneration"
```

---

### Task 4: `wiki_plan` loader (`lib/plan-file.js`)

**Files:**
- Create: `lib/plan-file.js`
- Test: `test/plan-file.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWikiPlan, parseWikiPlanYaml } = require('../lib/plan-file');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/plan-file.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/plan-file.js`**

```js
'use strict';
/**
 * Loader for the pre-generation wiki plan file (Qoder wiki_plan.yaml parity).
 * Zero-dependency: a strict parser for exactly the schema we accept — nested
 * maps, string scalars, lists of strings, and lists of maps with string
 * fields. Anything else (anchors, multi-line scalars, flow maps, tabs) is a
 * hard error with a line number. wiki_plan.json is accepted as an alternative.
 */
const fs = require('fs');
const path = require('path');

class PlanFileError extends Error {
  constructor(message, line) {
    super(line ? `wiki_plan.yaml line ${line}: ${message}` : `wiki_plan: ${message}`);
    this.line = line || null;
  }
}

const TEMPLATES = new Set(['', 'architecture', 'product_requirement']);

function stripQuotes(value, line) {
  const t = value.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    if (t[0] === '"') {
      if (t.includes('\\"')) throw new PlanFileError('escape sequences are not supported in double quotes', line);
      return t.slice(1, -1);
    }
    return t.slice(1, -1);
  }
  // strip trailing comment from bare scalars
  const hash = t.indexOf(' #');
  return (hash === -1 ? t : t.slice(0, hash)).trim();
}

// Parse the YAML subset into generic {map, list, scalar} structures.
function parseYamlSubset(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    if (raw.includes('\t')) throw new PlanFileError('tabs are not allowed; use spaces', index + 1);
    const content = raw.replace(/\s+#.*$/, ''); // full-line and trailing comments
    if (!content.trim() || content.trim().startsWith('#')) return;
    lines.push({ indent: content.length - content.trimStart().length, text: content.trimEnd(), line: index + 1 });
  });

  const parseBlock = (start, indent) => {
    // Decide map vs list from the first line at this indent.
    if (start >= lines.length || lines[start].indent !== indent) return { value: null, next: start };
    if (lines[start].text.startsWith('- ')) return parseList(start, indent);
    return parseMap(start, indent);
  };

  const parseScalarOrNested = (start) => {
    if (start < lines.length && lines[start].indent > lines[start - 1].indent && lines[start].text.startsWith('- ')) {
      return parseList(start, lines[start].indent);
    }
    return { value: null, next: start };
  };

  function parseMap(start, indent) {
    const map = {};
    let i = start;
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const match = lines[i].text.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
      if (!match) throw new PlanFileError(`expected "key: value", got "${lines[i].text}"`, lines[i].line);
      const [, key, rest] = match;
      if (key in map) throw new PlanFileError(`duplicate key "${key}"`, lines[i].line);
      if (rest === '') {
        const child = parseBlock(i + 1, nextIndent(i, indent));
        if (child.value === null) map[key] = null;
        else { map[key] = child.value; i = child.next - 1; }
      } else if (rest === '[]') {
        map[key] = [];
      } else if (rest === '{}') {
        map[key] = {};
      } else {
        map[key] = stripQuotes(rest, lines[i].line);
      }
      i++;
    }
    if (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith('- ')) {
      throw new PlanFileError(`unexpected deeper indentation at "${lines[i].text}"`, lines[i].line);
    }
    return { value: map, next: i };
  }

  function nextIndent(i, parentIndent) {
    if (i + 1 >= lines.length) return parentIndent + 2;
    const next = lines[i + 1];
    if (next.indent <= parentIndent) return parentIndent + 2; // empty block -> null
    return next.indent;
  }

  function parseList(start, indent) {
    const list = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const rest = lines[i].text.slice(2);
      const mapMatch = rest.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
      if (mapMatch) {
        // list item that is itself a map: first field inline, deeper fields after
        const item = {};
        const [, key, value] = mapMatch;
        item[key] = value === '' ? null : value === '[]' ? [] : stripQuotes(value, lines[i].line);
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent && !lines[j].text.startsWith('- ')) {
          const m2 = lines[j].text.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
          if (!m2) throw new PlanFileError(`expected "key: value" in list item, got "${lines[j].text}"`, lines[j].line);
          const [, k2, v2] = m2;
          if (k2 in item) throw new PlanFileError(`duplicate key "${k2}" in list item`, lines[j].line);
          item[k2] = v2 === '' ? null : v2 === '[]' ? [] : stripQuotes(v2, lines[j].line);
          j++;
        }
        list.push(item);
        i = j;
      } else {
        list.push(stripQuotes(rest, lines[i].line));
        i++;
      }
    }
    return { value: list, next: i };
  }

  const root = parseMap(0, lines.length ? lines[0].indent : 0);
  if (root.next < lines.length) {
    throw new PlanFileError(`unexpected content at "${lines[root.next].text}"`, lines[root.next].line);
  }
  return root.value;
}

const asString = (value, what, line) => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new PlanFileError(`${what} must be a string`, line);
  return value;
};

const asNoteList = (value, what) => {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') return { text: item, author: '' };
    if (!item || typeof item !== 'object') throw new PlanFileError(`${what}[${index}] must be a map with text/author`);
    const text = asString(item.text, `${what}[${index}].text`);
    if (!text.trim()) throw new PlanFileError(`${what}[${index}].text must not be empty`);
    return { text, author: asString(item.author, `${what}[${index}].author`) };
  });
};

const asStringList = (value, what) => (
  Array.isArray(value) ? value.map((v, i) => asString(v, `${what}[${i}]`)).filter(v => v.trim()) : []
);

function validateAndNormalize(raw) {
  if (!raw || typeof raw !== 'object') throw new PlanFileError('plan must be a map at the top level');
  const version = raw.version === undefined ? 1 : raw.version;
  if (version !== 1) throw new PlanFileError(`unsupported version ${JSON.stringify(version)} (expected 1)`);
  const allowed = new Set(['version', 'repowiki', 'knowledgecard', 'scope']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new PlanFileError(`unknown top-level key "${key}"`);
  }
  const repowiki = raw.repowiki || {};
  if (typeof repowiki !== 'object') throw new PlanFileError('repowiki must be a map');
  const template = asString(repowiki.template, 'repowiki.template');
  if (!TEMPLATES.has(template)) {
    throw new PlanFileError(`repowiki.template must be one of: "", "architecture", "product_requirement" (got "${template}")`);
  }
  const documents = Array.isArray(repowiki.documents) ? repowiki.documents.map((doc, index) => {
    if (!doc || typeof doc !== 'object') throw new PlanFileError(`repowiki.documents[${index}] must be a map`);
    const title = asString(doc.title, `documents[${index}].title`);
    if (!title.trim()) throw new PlanFileError(`repowiki.documents[${index}].title must not be empty`);
    return {
      title,
      goal: asString(doc.goal, `documents[${index}].goal`),
      parent: asString(doc.parent, `documents[${index}].parent`),
      hints: asString(doc.hints, `documents[${index}].hints`),
    };
  }) : [];
  for (const doc of documents) {
    if (doc.parent && !documents.some(other => other.title === doc.parent)) {
      throw new PlanFileError(`document "${doc.title}" references unknown parent "${doc.parent}"`);
    }
  }
  const knowledgecard = raw.knowledgecard || {};
  if (typeof knowledgecard !== 'object') throw new PlanFileError('knowledgecard must be a map');
  const scope = raw.scope || {};
  if (typeof scope !== 'object') throw new PlanFileError('scope must be a map');
  const include = asStringList(scope.include, 'scope.include');
  const exclude = asStringList(scope.exclude, 'scope.exclude');
  return {
    version: 1,
    repowiki: { template, notes: asNoteList(repowiki.notes, 'repowiki.notes'), documents },
    knowledgecard: { notes: asNoteList(knowledgecard.notes, 'knowledgecard.notes') },
    scope: { include, exclude },
  };
}

function parseWikiPlanYaml(text) {
  return validateAndNormalize(parseYamlSubset(text));
}

function parseWikiPlanJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PlanFileError(`wiki_plan.json is not valid JSON: ${err.message}`);
  }
  return validateAndNormalize(raw);
}

function loadWikiPlan(repoDir) {
  const yamlPath = path.join(repoDir, 'wiki_plan.yaml');
  const jsonPath = path.join(repoDir, 'wiki_plan.json');
  if (fs.existsSync(yamlPath)) return parseWikiPlanYaml(fs.readFileSync(yamlPath, 'utf8'));
  if (fs.existsSync(jsonPath)) return parseWikiPlanJson(fs.readFileSync(jsonPath, 'utf8'));
  return null;
}

module.exports = { loadWikiPlan, parseWikiPlanYaml, parseWikiPlanJson, PlanFileError };
```

Note: the `parseScalarOrNested` helper in the skeleton above is unused — delete it; `parseMap` handles nesting via `parseBlock`. If the empty-block (`key:` with no children) path returns `null`, `validateAndNormalize` treats it as absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/plan-file.test.js`
Expected: PASS (8 tests). Fix parser edge cases until green; keep errors carrying line numbers.

- [ ] **Step 5: Commit**

```bash
git add lib/plan-file.js test/plan-file.test.js
git commit -m "feat: add strict wiki_plan loader (yaml subset + json)"
```

---

### Task 5: Scope filtering (`lib/scope-filter.js`)

**Files:**
- Create: `lib/scope-filter.js`
- Modify: `lib/scan.js` (export tree/langStats builders), `lib/api.js` (apply scope after scan)
- Test: `test/scope-filter.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scope-filter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Refactor `lib/scan.js` to export the builders**

Extract the tree-building block and the langStats block from `scanRepo` into exported functions (same code, moved):

```js
function buildTreeLines(files) {
  const treeLines = [];
  const seen = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      treeLines.push('  '.repeat(i) + parts[i] + (i < parts.length - 1 ? '/' : ''));
    }
  }
  const TREE_CAP = 400;
  return treeLines.length > TREE_CAP
    ? treeLines.slice(0, TREE_CAP).join('\n') + `\n... (${treeLines.length - TREE_CAP} more entries)`
    : treeLines.join('\n');
}

function buildLangStats(files) {
  const byExt = {};
  for (const f of files) {
    const ext = path.extname(f.rel) || '(none)';
    byExt[ext] = byExt[ext] || { count: 0, bytes: 0 };
    byExt[ext].count++;
    byExt[ext].bytes += f.size;
  }
  return Object.entries(byExt)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([ext, s]) => `${ext}: ${s.count} files, ${(s.bytes / 1024).toFixed(0)} KB`)
    .join('; ');
}
```

`scanRepo` calls both; `module.exports = { scanRepo, buildTreeLines, buildLangStats };`

- [ ] **Step 4: Implement `lib/scope-filter.js`**

```js
'use strict';
/**
 * wiki_plan scope.include/exclude — gitignore-flavored globs applied to a
 * finished scan. Supported: '*' within a segment, '**' across segments,
 * trailing '/' (directory prefix), leading '/' (anchor at repo root).
 * include (when non-empty) is an allowlist; exclude always removes.
 */
const { buildTreeLines, buildLangStats } = require('./scan');

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compilePattern(pattern) {
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = body.split('/');
  const segmentRx = segments.map(seg => (
    seg === '**'
      ? '(?:[^/]+/)*[^/]*'      // any number of full segments + a partial one
      : seg.split('*').map(escapeRx).join('[^/]*')
  ));
  // A '**' segment followed by more segments must also allow matching a prefix
  // of full segments: 'src/**' should match 'src/a/b.js'.
  let rx = '^';
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '**') {
      rx += i === segments.length - 1 ? '(?:[^/]+/)*[^/]*' : '(?:[^/]+/)*';
    } else {
      rx += segmentRx[i];
      if (i < segments.length - 1) rx += '/';
    }
  }
  const full = new RegExp(rx + '$');
  return (rel) => {
    if (full.test(rel)) return true;
    if (directory) {
      // 'src/' matches everything under src/
      const prefix = body + '/';
      return rel === body || rel.startsWith(prefix);
    }
    if (!anchored) {
      // unanchored patterns may match from any directory boundary
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (full.test(parts.slice(i).join('/'))) return true;
      }
      // bare-name patterns match a single segment anywhere ('*.md')
      if (!body.includes('/')) return full.test(rel.split('/').pop());
    }
    return false;
  };
}

function applyScope(scan, scope) {
  const include = (scope && scope.include) || [];
  const exclude = (scope && scope.exclude) || [];
  if (!include.length && !exclude.length) return scan;
  const includeMatchers = include.map(compilePattern);
  const excludeMatchers = exclude.map(compilePattern);
  const files = scan.files.filter(f => {
    if (excludeMatchers.some(m => m(f.rel))) return false;
    if (include.length && !includeMatchers.some(m => m(f.rel))) return false;
    return true;
  });
  if (files.length === 0) {
    const err = new Error('wiki_plan scope excludes every scanned file — refusing to plan an empty wiki');
    err.code = 'empty_scope';
    throw err;
  }
  return {
    ...scan,
    files,
    fileSet: new Set(files.map(f => f.rel)),
    tree: buildTreeLines(files),
    langStats: buildLangStats(files),
  };
}

module.exports = { applyScope, compilePattern };
```

- [ ] **Step 5: Wire into `lib/api.js`**

In `generateWiki`, right after `const scan = scanRepo(repoDir)` and the empty-scan check:

```js
const wikiPlan = loadWikiPlan(repoDir);   // require('./plan-file') at top
const effectiveScan = wikiPlan ? applyScope(scan, wikiPlan.scope) : scan;
```

Then use `effectiveScan` everywhere downstream (rename the local `scan` to `effectiveScan` at the use sites: planMessages, coverage, buildFilesBlock, knowledge). Emit `emit('plan_file_loaded', { file: 'wiki_plan.yaml', documents: wikiPlan.repowiki.documents.length, scope: { include: wikiPlan.scope.include.length, exclude: wikiPlan.scope.exclude.length } })` when a plan file was found. Human reporter: `log('  wiki_plan: loaded (documents: N, scope: +I/-E)')`.

- [ ] **Step 6: Run tests**

Run: `node --test test/scope-filter.test.js && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/scope-filter.js lib/scan.js lib/api.js test/scope-filter.test.js
git commit -m "feat: apply wiki_plan scope include/exclude to the scan"
```

---

### Task 6: Plan notes, template presets, strict documents mode

**Files:**
- Modify: `lib/prompts.js`, `lib/plan.js`, `lib/api.js`
- Test: `test/plan-strict-documents.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');
const { scanRepo } = require('../lib/scan');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');
const CONFIG = path.join(__dirname, 'config.json');

function runGenerator(repo, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, repo, '--config', CONFIG, ...extraArgs], {
      cwd: APP_DIR, env: { ...process.env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-docs-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/payments.js'), 'function charge() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'src/orders.js'), 'function order() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'src/legacy.js'), 'function legacy() { return 3; }\n');
  return repo;
}

const PLAN = `version: 1
repowiki:
  notes:
    - text: "Focus on business workflows rather than code details"
  documents:
    - title: "Payments Guide"
      goal: "Explain how charging works"
    - title: "Order Flow"
      goal: "Explain the order lifecycle"
      parent: "Payments Guide"
      hints: "Mention refunds"
`;

test('strict documents mode outputs exactly the listed pages', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'wiki_plan.yaml'), PLAN);
    const run = await runGenerator(repo);
    assert.equal(run.code, 0, run.stderr);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const paths = catalog.pages.map(p => p.path).sort();
    // Payments Guide is a parent -> landing page in its own directory
    assert.ok(paths.includes('payments-guide/payments-guide.md'), `got: ${paths.join(', ')}`);
    assert.ok(paths.includes('payments-guide/order-flow.md'), `got: ${paths.join(', ')}`);
    assert.equal(catalog.pages.length, 2, 'exactly the two planned documents, nothing more');
    const orderPage = catalog.pages.find(p => p.path.endsWith('order-flow.md'));
    assert.equal(orderPage.parent, 'payments-guide/payments-guide.md');
  } finally {
    await server.stop();
  }
});

test('planned page metadata keeps goal as description and hints reach the page prompt', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'wiki_plan.yaml'), PLAN);
    const run = await runGenerator(repo);
    assert.equal(run.code, 0, run.stderr);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const orderPage = catalog.pages.find(p => p.path.endsWith('order-flow.md'));
    assert.match(orderPage.description, /order lifecycle/i);
    // the mock server records requests; assert the hint text reached the prompt
    const requests = server.requests(); // follow mock-llm.js API; adapt if named differently
    const orderPrompt = requests.find(r => r.body.includes('Payments Guide')) || {};
    assert.ok(String(orderPrompt.body || '').includes('Mention refunds'), 'hints must reach the LLM prompt');
  } finally {
    await server.stop();
  }
});
```

Before finalizing the test, read `test/mock-llm.js` and adapt `server.requests()` to whatever request-recording API it exposes (add one if missing — mirror the existing dispatch helpers).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/plan-strict-documents.test.js`
Expected: FAIL — normal LLM planning ran instead (pages don't match the documents list).

- [ ] **Step 3: Implement prompt + planning changes**

In `lib/prompts.js` add:

```js
// Qoder wiki_plan parity: guidance notes and template presets injected into
// the planning and writing prompts.
function notesBlock(notes, heading) {
  if (!notes || !notes.length) return '';
  const lines = notes.map(n => `- "${n.text}"${n.author ? ` (author: ${n.author})` : ''}`);
  return `\n${heading}:\n${lines.join('\n')}\n`;
}

const TEMPLATE_PRESETS = {
  architecture: {
    plan: 'Template preset "architecture": organize the wiki as a comprehensive technical analysis — module boundaries, data flow, dependencies, and internal APIs.',
    page: 'Template preset "architecture": favor technical depth — module boundaries, data flow, dependencies.',
  },
  product_requirement: {
    plan: 'Template preset "product_requirement": organize the wiki around product requirements and user-facing capabilities rather than internal code structure.',
    page: 'Template preset "product_requirement": frame content around user-facing capabilities and requirements.',
  },
};

function assignFilesMessages(scan, documents, opts = {}) {
  const system = 'You are a senior software architect assigning source files to documentation pages. You respond with valid JSON only — no prose, no markdown fences.';
  const user = `Assign the most relevant source files to each documentation page for the repository "${scan.name}".

Repository file tree:
${scan.tree}

Language statistics: ${scan.langStats || 'n/a'}
${notesBlock(opts.notes, 'Author guidance')}
Pages (fixed — do not add, remove, or rename):
${documents.map(d => `- title: ${JSON.stringify(d.title)}${d.goal ? `, goal: ${JSON.stringify(d.goal)}` : ''}${d.hints ? `, hints: ${JSON.stringify(d.hints)}` : ''}`).join('\n')}

Return ONLY a JSON object:
{
  "documents": [
    { "title": "<exact title from the list>", "files": ["relative/path", "..."] }
  ]
}

Rules:
- Echo the page titles exactly as given, one entry per page, same order.
- "files" must list ONLY paths from the file tree above, max 12 per page.
- Every source-code file in the tree must appear in at least one page's "files".
- Do not invent files. JSON only.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
```

Extend `planMessages(scan, opts)` and `pageMessages(scan, page, filesBlock, opts)` to append, when provided:
- `opts.notesBlock` text (from `notesBlock(wikiPlan.repowiki.notes, 'Author guidance')`)
- `opts.templatePreset` text (from `TEMPLATE_PRESETS[template].plan` / `.page`)

In `lib/plan.js` add:

```js
// Qoder strict documents mode: the page list comes from wiki_plan.yaml; the
// LLM only assigns files. Deterministic layout mirrors the landing-page
// convention: a parent page lives at <slug>/<slug>.md and its children at
// <slug>/<child-slug>.md. Parentless documents sit at the content root.
function slugifyPagePath(title) {
  return sanitizePagePath(
    String(title).trim().toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
  );
}

function planFromDocuments(documents, assignments) {
  const byTitle = new Map(documents.map(d => [d.title, d]));
  const filesByTitle = new Map(
    (Array.isArray(assignments) ? assignments : [])
      .filter(a => byTitle.has(a.title))
      .map(a => [a.title, a.files || []])
  );
  const childrenOf = new Map();
  for (const doc of documents) {
    if (!doc.parent) continue;
    if (!childrenOf.has(doc.parent)) childrenOf.set(doc.parent, []);
    childrenOf.get(doc.parent).push(doc);
  }
  const pages = [];
  for (const doc of documents) {
    if (doc.parent) continue; // emitted with the parent below
    const slug = slugifyPagePath(doc.title);
    const kids = childrenOf.get(doc.title) || [];
    if (kids.length) {
      const parentPath = `${slug}/${slug}.md`;
      pages.push({
        path: parentPath,
        title: doc.title,
        description: doc.goal || `Overview of ${doc.title}`,
        files: filesByTitle.get(doc.title) || [],
        _landing: true,
        _children: kids.map(kid => ({
          path: `${slug}/${slugifyPagePath(kid.title)}`,
          title: kid.title,
          description: kid.goal || '',
          files: filesByTitle.get(kid.title) || [],
          _hints: kid.hints || '',
        })),
      });
      for (const kid of kids) {
        const child = pages[pages.length - 1]._children.find(c => c.title === kid.title);
        pages.push(child);
      }
    } else {
      pages.push({
        path: `${slug}.md`,
        title: doc.title,
        description: doc.goal || '',
        files: filesByTitle.get(doc.title) || [],
        _hints: doc.hints || '',
      });
    }
  }
  return pages;
}
```

Export `planFromDocuments` from `lib/plan.js`.

In `lib/api.js`, replace the Stage-1 planning block when the plan file has documents:

```js
let pages;
if (wikiPlan && wikiPlan.repowiki.documents.length) {
  // strict mode: fixed page list, LLM only assigns files (1 call, up to 3 attempts)
  let assignment = null;
  for (let attempt = 1; attempt <= 3 && !assignment; attempt++) {
    try {
      const completion = await chatDetailed(profile, assignFilesMessages(effectiveScan, wikiPlan.repowiki.documents, {
        notes: wikiPlan.repowiki.notes,
      }), { maxTokens: profile.maxTokens, retries: profile.retries });
      const parsed = extractJson(completion.content);
      if (Array.isArray(parsed && parsed.documents)) assignment = parsed.documents;
    } catch (err) {
      emit('plan_retry', { attempt, codes: 'assignment_error' });
    }
  }
  if (!assignment) throw new ApiError('plan_failed', 'wiki_plan file assignment failed after 3 attempts');
  pages = planFromDocuments(wikiPlan.repowiki.documents, assignment);
  pages = normalizePlan(pages, effectiveScan, {
    maxPages: Math.max(wikiPlan.repowiki.documents.length, pages.length),
    ensureCoverage: config.ensureCoverage !== false,
  }).pages;
  emit('plan_ready', { pages: pages.map(p => ({ path: p.path, title: p.title })), coverage: 0, strict: true });
} else {
  // existing LLM planning loop (unchanged), now passing
  // notes: wikiPlan && wikiPlan.repowiki.notes, template: wikiPlan && wikiPlan.repowiki.template
}
```

`normalizePlan` must not drop the `_hints` field — check its page-mapping code and carry `_hints` through. Thread `page._hints` into `pageMessages` opts as `hints` and append to the focus line: `opts.hints ? `\nAuthor hints: ${opts.hints}\n` : ''`. Thread `knowledgecard.notes` into the `knowledgeMessages` call opts as `notes` → append `notesBlock(notes, 'Author guidance')`.

- [ ] **Step 4: Run tests**

Run: `node --test test/plan-strict-documents.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts.js lib/plan.js lib/api.js test/plan-strict-documents.test.js test/mock-llm.js
git commit -m "feat: wiki_plan notes, template presets, and strict documents mode"
```

---

### Task 7: Modify / Supplement / Rewrite (`modifyWiki`)

**Files:**
- Modify: `lib/api.js` (implement `modifyWiki`), `lib/prompts.js` (`modifyPageMessages`)
- Test: `test/api-modify.integration.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');
const CONFIG = path.join(__dirname, 'config.json');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, ...args], { cwd: APP_DIR, env: { ...process.env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-modify-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() { return 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"modify-fixture","version":"1.0.0"}\n');
  return repo;
}

test('supplement appends content and marks the page curated/protected', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    assert.equal((await runCli([repo, '--config', CONFIG])).code, 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const target = catalog.pages.find(p => !p.isLanding) || catalog.pages[0];
    const pageFile = path.join(repo, '.local-wiki/en/content', target.path);
    const before = fs.readFileSync(pageFile, 'utf8');

    const mod = await runCli([repo, '--config', CONFIG,
      '--modify', target.path, '--op', 'supplement',
      '--instruction', 'Add a section about the mock provider']);
    assert.equal(mod.code, 0, mod.stderr);

    const after = fs.readFileSync(pageFile, 'utf8');
    assert.ok(after.length > before.length, 'supplement must not shrink the page');
    assert.ok(after.includes(before.replace(/^# .*$/m, after.match(/^# .*$/m)[0])) || after.startsWith(before.split('\n')[0]),
      'original heading/structure must survive a supplement');

    const catalog2 = JSON.parse(fs.readFileSync(path.join(repo, '.local-wiki/en/meta/catalog.json'), 'utf8'));
    const meta2 = catalog2.pages.find(p => p.path === target.path);
    assert.equal(meta2.protected, true, 'modified page becomes protected (curated)');

    // code drift on a dependent file must NOT clobber the curated page
    const dep = target.dependent_files[0] || 'a.js';
    fs.appendFileSync(path.join(repo, dep), '\n// drift\n');
    const drift = await runCli([repo, '--config', CONFIG]);
    assert.equal(drift.code, 0, drift.stderr);
    assert.match(drift.stdout, /protected: curated/);
    assert.equal(fs.readFileSync(pageFile, 'utf8'), after, 'curated page survives regeneration');
  } finally {
    await server.stop();
  }
});

test('modify fails cleanly for an unknown page path', async () => {
  const server = createMockServer();
  await server.start();
  try {
    const repo = makeRepo();
    assert.equal((await runCli([repo, '--config', CONFIG])).code, 0);
    const mod = await runCli([repo, '--config', CONFIG, '--modify', 'nope.md', '--op', 'rewrite', '--instruction', 'x']);
    assert.notEqual(mod.code, 0);
    assert.match(mod.stderr, /nope\.md/);
  } finally {
    await server.stop();
  }
});
```

Mock server: the modify prompt is a new prompt shape — extend `test/mock-llm.js` dispatch (detect the modify system prompt or an `operation` marker) to return a valid page that satisfies `validatePage` (single H1, balanced fences, citations only from attached) and, for supplement, includes the original content plus a new section. Follow the existing mock response builders.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-modify.integration.test.js`
Expected: FAIL — `--modify` is not implemented (ApiError not_implemented).

- [ ] **Step 3: Implement `modifyPageMessages` in `lib/prompts.js`**

```js
const MODIFY_OPERATION_RULES = {
  modify: 'MODIFY: change only what the instruction asks. Keep the existing structure, headings, and style; do not remove unrelated content.',
  supplement: 'SUPPLEMENT: append new content per the instruction. Never delete or rewrite existing sections; only add new ones (or extend existing ones where the instruction says so).',
  rewrite: 'REWRITE: produce a fresh full rewrite of the page that still serves its original purpose and follows the instruction. Restructuring is allowed.',
};

function modifyPageMessages(scan, page, currentMarkdown, filesBlock, opts) {
  const attached = opts.attached || [];
  const operation = MODIFY_OPERATION_RULES[opts.operation] ? opts.operation : 'modify';
  const citeList = attached.map(rel => `- [${rel}](${rel})`).join('\n');
  const system =
    'You are a senior technical writer editing an existing wiki page of a code repository. ' +
    'You answer with the complete updated page in GitHub-flavored markdown only — no commentary, no fences around the whole page.';
  const user = `Update the wiki page "${page.title}" (${page.path}) of the repository "${scan.name}".

${MODIFY_OPERATION_RULES[operation]}

Instruction from the user:
"""
${opts.instruction}
"""

Current page content:
<current_page>
${currentMarkdown}
</current_page>

Attached source files (the ONLY citable sources):
${citeList || '(none)'}

${filesBlock}

Rules:
- Return the COMPLETE updated page markdown (title as a single "# " H1 first line).
- Keep the page in the same language as the current content.
- Cite only attached files, as links like [path](path) or ranges [path:L1-L5](path#L1-L5); line ranges must exist in the attached content.
- Do not invent files, APIs, flags, or commands that are not in the attached sources or the current page.
- Mermaid diagrams are allowed inside \`\`\`mermaid fences when they clarify the update.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
```

Export it. Add `repairPageMessages`-style repair? Reuse `repairPageMessages` only if its signature fits; otherwise run up to 3 attempts feeding violations back via a small wrapper that appends the violations block to the same messages (mirror `repairPlanMessages`'s approach).

- [ ] **Step 4: Implement `modifyWiki` in `lib/api.js`**

```js
async function modifyWiki(repoDir, options = {}, onEvent = () => {}) {
  const opts = normalizeOptions(options);
  const { bus, emit } = createEventBus();
  bus.on('event', onEvent);
  const pagePathInput = String(options.modify || options.pagePath || '');
  const operation = ['modify', 'supplement', 'rewrite'].includes(options.op || options.operation)
    ? (options.op || options.operation) : 'modify';
  const instruction = String(options.instruction || '').trim();
  if (!pagePathInput) throw new ApiError('bad_args', '--modify requires a page path');
  if (!instruction) throw new ApiError('bad_args', '--modify requires --instruction');

  // config/profile/state/layout — same loading sequence as generateWiki
  loadDotenv(repoDir);
  const { config, configPath } = loadConfig(opts, repoDir);
  const { name: modelName, profile } = pickProfile(config, opts);
  const requestedOutDir = path.resolve(opts.out || path.join(repoDir, '.local-wiki/en/content'));
  const outputLayout = deriveOutputLayout(requestedOutDir, config.language || 'en');
  const liveOutDir = requestedOutDir;
  const liveMetaDir = outputLayout.metaDir;

  // resolve the page against the catalog (exact, then unique substring)
  const catalogPath = path.join(liveMetaDir, 'catalog.json');
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); }
  catch { throw new ApiError('no_wiki', `no published wiki found (missing ${catalogPath}) — run a generation first`); }
  const pages = (catalog.pages || []).filter(p => p.path === pagePathInput);
  let page = pages[0] || null;
  if (!page) {
    const matches = (catalog.pages || []).filter(p => p.path.includes(pagePathInput));
    if (matches.length === 1) page = matches[0];
    else throw new ApiError('unknown_page', matches.length
      ? `ambiguous page "${pagePathInput}": ${matches.map(m => m.path).join(', ')}`
      : `page not found: ${pagePathInput}`);
  }

  const livePagePath = path.join(liveOutDir, page.path);
  let currentMarkdown;
  try { currentMarkdown = fs.readFileSync(livePagePath, 'utf8'); }
  catch { throw new ApiError('unknown_page', `published page file missing: ${page.path}`); }

  emit('run_started', { repo: repoDir, model: modelName, provider: profile.provider, modelId: profile.model || profile.modelPath, configPath, outDir: liveOutDir, mode: `modify:${operation}` });
  const scan = scanRepo(repoDir);
  const attached = (page.dependent_files || []).filter(rel => scan.fileSet.has(rel));
  const { block, attached: validatedAttached, lineCounts, rawByPath, visibleByPath } =
    buildFilesBlock(repoDir, { path: page.path, files: attached }, scan, profile.contextChars || 24000);

  const runId = newRunId();
  const diagnostics = createRunDiagnostics(outputLayout.runsDir, {
    runId, repo: scan.name, provider: profile.provider,
    model: profile.model || profile.modelPath || modelName,
    flags: { modify: operation, page: page.path },
  });

  const transaction = createRunTransaction([{ name: 'content', live: liveOutDir }], runId);
  transaction.prepare();
  try {
    const outFile = transaction.stagePath('content') === liveOutDir
      ? livePagePath
      : path.join(transaction.stagePath('content'), page.path);
    let validation; let md = ''; let rejected = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const messages = attempt === 0
        ? modifyPageMessages(scan, page, currentMarkdown, block, { attached: validatedAttached, operation, instruction })
        : appendRepairFeedback(modifyPageMessages(scan, page, currentMarkdown, block, { attached: validatedAttached, operation, instruction }), rejected, validation.violations);
      const completion = await chatDetailed(profile, messages, { maxTokens: profile.maxTokens, retries: profile.retries });
      rejected = unwrapMarkdown(completion.content);
      const citationResult = sanitizeCitations(rejected, validatedAttached, lineCounts);
      md = citationResult.md;
      validation = validatePage(md, {
        page: { path: page.path, title: page.title, description: page.description },
        attached: validatedAttached,
        citationResult,
        completion,
        rawByPath,
        visibleByPath,
      });
      diagnostics.recordPageAttempt(page.path, attempt + 1, rejected, {
        provider: profile.provider,
        model: profile.model || profile.modelPath || modelName,
        finishReason: completion.finishReason,
        usage: completion.usage,
        citationViolations: citationResult.violations,
        violations: validation.violations,
        stats: validation.stats,
        accepted: validation.ok,
      });
      if (validation.ok) break;
      emit('page_retry', { path: page.path, attempt: attempt + 1, codes: [...new Set(validation.violations.map(v => v.code))].join(',') });
    }
    if (!validation.ok) throw new ApiError('modify_validation', `quality validation failed after 3 attempts (${
      [...new Set(validation.violations.map(v => v.code))].join(',')})`);

    const content = `${md.trim()}\n`;
    atomicWrite(outFile, content);
    transaction.commit();
    // state update: keep the input hash (future code drift still triggers regen
    // attempts), record the new output hash, and mark the page curated/protected
    const statePath = path.join(liveOutDir, '.state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* fresh */ }
    if (!state.pageMetadata || typeof state.pageMetadata !== 'object') state.pageMetadata = {};
    const prior = state.pageMetadata[page.path] || {};
    state.pageMetadata[page.path] = {
      ...prior,
      ...page,
      dependent_files: validatedAttached.length ? validatedAttached : (page.dependent_files || []),
      curated: true,
      externallyModified: false,
      quality: 'ok',
      outputHash: sha1(content),
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
    // catalog refresh: mark protected
    page.protected = true;
    catalog.generatedAt = new Date().toISOString();
    atomicWrite(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    diagnostics.finish('committed', { publishedPages: (catalog.pages || []).length, modify: operation });
    emit('page_done', { path: page.path, status: 'generated', chars: md.length, files: validatedAttached.length, operation });
    emit('run_finished', { stats: { generated: 1, degraded: 0, skipped: 0, failed: 0, knowledgeFailed: 0 }, outDir: liveOutDir, tip: '' });
    return { path: page.path, operation };
  } catch (err) {
    try { transaction.abort(); } catch (rollbackError) { err.rollbackError = rollbackError; }
    diagnostics.finish('aborted', { fatalError: err.message });
    emit('page_fail', { path: page.path, message: err.message });
    throw err instanceof ApiError ? err : new ApiError('modify_failed', err.message);
  }
}
```

Add the small helper next to it (and use it in the repair loop above):

```js
function appendRepairFeedback(messages, rejected, violations) {
  const list = (violations || []).map(item => `- ${item.code}: ${item.message}`).join('\n');
  return messages.map((m, index) => index === messages.length - 1
    ? { ...m, content: `${m.content}\n\nThe previous draft was rejected:\n${list || '- validation failed'}\n\n<rejected_draft>\n${String(rejected)}\n</rejected_draft>\n\nReturn the complete corrected page.` }
    : m);
}
```

Note: `atomicWrite`, `unwrapMarkdown`, `sha1`, `newRunId` are already in `lib/api.js` from Task 2. `page.protected` marking requires the catalog build in `generateWiki` to also emit `protected` (Task 3 step 3.5 does). `modifyPageMessages` import comes from `./prompts`.

- [ ] **Step 5: Run tests**

Run: `node --test test/api-modify.integration.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/api.js lib/prompts.js test/api-modify.integration.test.js test/mock-llm.js
git commit -m "feat: add modify/supplement/rewrite operation with curated-page protection"
```

---

### Task 8: Qoder guards (repo size + git history)

**Files:**
- Modify: `lib/api.js`
- Test: `test/api-guards.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gitHasCommit } = require('../lib/api');

test('gitHasCommit is false without .git, true for a real repo', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-git-'));
  assert.equal(gitHasCommit(empty), false);
  assert.equal(gitHasCommit(path.resolve(__dirname, '..')), true); // this repo has commits
});
```

Plus an integration assertion: spawn the CLI against a temp repo WITHOUT git and assert stderr/stdout contains the warning but exit code stays 0 (use the same runGenerator helper pattern from Task 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-guards.test.js`
Expected: FAIL — `gitHasCommit` not exported.

- [ ] **Step 3: Implement the guards in `lib/api.js`**

```js
function gitHasCommit(repoDir) {
  const gitPath = path.join(repoDir, '.git');
  let head = null;
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    else if (stat.isFile()) {
      // worktree/submodule gitdir pointer
      const gitdir = head = fs.readFileSync(gitPath, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
      if (gitdir) {
        const headText = fs.readFileSync(path.join(gitdir[1], 'HEAD'), 'utf8').trim();
        head = headText;
      }
    }
  } catch { return false; }
  if (!head) return false;
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5).trim();
    const refPath = path.join(repoDir, '.git', ref);
    try {
      if (fs.statSync(refPath).isFile()) return fs.readFileSync(refPath, 'utf8').trim().length > 0;
    } catch { /* fall through to packed-refs */ }
    try {
      const packed = fs.readFileSync(path.join(repoDir, '.git', 'packed-refs'), 'utf8');
      return new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm').test(packed);
    } catch { return false; }
  }
  return /^[0-9a-f]{40,64}$/i.test(head); // detached HEAD pointing at a commit
}
```

In `generateWiki`, after `scanRepo`:

```js
if (!gitHasCommit(repoDir)) {
  emit('scan_warning', { message: 'not a Git repository with at least one commit — Qoder requires one; continuing anyway' });
}
if (effectiveScan.files.length > 10000) {
  emit('scan_warning', { message: `${effectiveScan.files.length} files exceeds Qoder's 10,000-file wiki limit; consider a wiki_plan scope exclude` });
}
```

Human reporter already prints `scan_warning` as `  WARN  <message>` (Task 1). Export `gitHasCommit`.

- [ ] **Step 4: Run tests**

Run: `node --test test/api-guards.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/api.js test/api-guards.test.js
git commit -m "feat: warn on non-git repos and 10k+ file scans (qoder parity guards)"
```

---

### Task 9: NDJSON mode end-to-end (`--json-events`)

**Files:**
- Modify: `generate.js` (reporter selection — already written in Task 2), `lib/events.js` (verify coverage)
- Test: `test/api-json-events.integration.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-llm');

const APP_DIR = path.resolve(__dirname, '..');
const GENERATOR = path.join(APP_DIR, 'generate.js');
const CONFIG = path.join(__dirname, 'config.json');

test('--json-events emits a valid NDJSON event sequence', async () => {
  const server = createMockServer();
  await server.start();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ndjson-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ndjson-fixture","version":"1.0.0"}\n');
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [GENERATOR, repo, '--config', CONFIG, '--json-events'], {
        cwd: APP_DIR, env: { ...process.env },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(run.code, 0, run.stderr);
    const events = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    const types = events.map(e => e.type);
    assert.equal(types[0], 'run_started');
    assert.ok(types.includes('plan_ready'));
    assert.ok(types.includes('run_finished'));
    assert.equal(types[types.length - 1], 'run_finished');
    const finished = events.find(e => e.type === 'run_finished');
    assert.ok(finished.stats && typeof finished.stats.generated === 'number');
    for (const e of events) assert.ok(e.ts && e.type, 'every event carries ts + type');
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test test/api-json-events.integration.test.js`
If Task 2's CLI rewrite already routes `--json-events` correctly this passes immediately — that is fine; the test then exists as the contract for the extension. If anything human-readable leaks onto stdout (dotenv line, listModels), fix the leak: loadDotenv's message must go through `emit` (pass a no-op in json mode), and `Scanning repository...`/any leftover `console.log` in api.js must be an emit.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/api-json-events.integration.test.js generate.js lib/api.js
git commit -m "test: pin the NDJSON event contract for machine consumers"
```

---

### Task 10: Documentation

**Files:**
- Create: `wiki-plan.schema.md`
- Modify: `README.md`

- [ ] **Step 1: Write `wiki-plan.schema.md`**

Document: file locations (`wiki_plan.yaml` / `wiki_plan.json` at repo root, committed to git), the full schema with every field (`version`, `repowiki.template` values and what each preset does, `repowiki.notes` (text/author) injection point, `repowiki.documents` strict mode with title/goal/parent/hints and the deterministic path layout `<slug>/<slug>.md` for parents, `knowledgecard.notes`, `scope.include/exclude` glob semantics), the strict-parser limitations (no tabs, no anchors, no flow maps, quoted strings without escapes), that changes require an explicit regenerate, and a complete example copied from `test/plan-file.test.js`'s VALID fixture.

- [ ] **Step 2: Update `README.md`**

- New "Wiki plan file" section (short, links to `wiki-plan.schema.md`).
- CLI help block: add `--json-events`, `--modify/--op/--instruction`.
- New "Editing the wiki" section: manual edits are protected (dual-hash), modify/supplement/rewrite examples, `--force` semantics.
- New "Programmatic API + events" section: `require('./lib/api')` example with a 6-line event-tap snippet and the event-type table (run_started, env_loaded, scan_done, scan_warning, plan_file_loaded, plan_started, plan_retry, plan_ready, dry_run, page_start, page_retry, page_note, page_done, page_fail, stale_removed, catalog_written, knowledge_started, knowledge_card_fail, knowledge_done, knowledge_failed_run, run_aborted, run_finished, run_error, cleanup_warning, model_profile).

- [ ] **Step 3: Verify docs against behavior**

Run: `node generate.js --help` and diff the printed options against the README CLI block. Run `node generate.js <tmpprovider-repo> --dry-run` once against a fixture with a `wiki_plan.yaml` to confirm the `plan_file_loaded` event/line appears.

- [ ] **Step 4: Commit**

```bash
git add wiki-plan.schema.md README.md
git commit -m "docs: document wiki_plan schema, modify ops, and the event API"
```

---

## Self-review notes (checked during planning)

- Spec coverage: wiki_plan (Tasks 4–6), modify/supplement/rewrite (7), dual-hash protection + update/sync (3), guards (8), lib/api.js + NDJSON (1–2, 9), docs (10). PDF export already exists (`export.js`); the extension plan (Plan B) adds the `exportPdf` command — not duplicated here.
- Type consistency: `snapshotPageMetadata(page, attached, outputHash)` third param used at both write sites; `metadata.protected` computed as `curated || externallyModified` in both catalog paths (generate + modify); event names identical in `lib/events.js` reporter switch and the emits listed per task.
- Known risk flagged for the executor: Task 2 is the only large mechanical move; the baseline test run (Step 1) plus unchanged integration suite is the acceptance gate. Task 6's `normalizePlan` must preserve `_hints` — verify in its page mapping before wiring.
