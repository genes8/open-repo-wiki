# Transactional Generation Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every wiki generation run transactional, regression-aware, explicitly prunable, diagnosable, structurally valid, and resistant to truncated or command-hallucinating completions.

**Architecture:** Keep `generate.js` as the orchestrator but extract plan policy, run diagnostics, and staged filesystem publication into focused CommonJS modules. Every run validates/retries its plan, builds a complete next snapshot in sibling staging directories, records model evidence outside the live wiki, and swaps live targets only after every requested artifact passes.

**Tech Stack:** Node.js 18+, CommonJS, built-in `node:test`, `node:assert/strict`, `fs`, `path`, built-in `fetch`, existing mock OpenAI-compatible server.

---

## File Map

- Create `lib/plan-quality.js`: previous-plan recovery, topic classification,
  structural violations, count/topic regression policy.
- Create `lib/run-diagnostics.js`: safe atomic run evidence under
  `.local-wiki/runs/<run-id>`.
- Create `lib/run-transaction.js`: stage-copy, commit, rollback, abort, and safe
  cleanup for content/meta/knowledge targets.
- Modify `lib/providers.js`: add `chatDetailed()` while preserving `chat()`.
- Modify `lib/quality.js`: completion and shell-command semantic gates.
- Modify `lib/prompts.js`: planner repair and source-backed command rules.
- Modify `generate.js`: new flags, planner retry, staged paths, diagnostics,
  no-failure publication, explicit stale cleanup, state schema 3.
- Modify `test/mock-llm.js`: sequenced plans, response finish reasons, and
  knowledge/page failure controls.
- Create `test/plan-quality.test.js`, `test/run-diagnostics.test.js`, and
  `test/run-transaction.test.js`.
- Modify `test/providers.test.js`, `test/quality.test.js`,
  `test/prompts.test.js`, and `test/generate.integration.test.js`.
- Modify `README.md`: document transaction, flags, diagnostics, and recovery.

### Task 1: Plan quality and bounded planner repair

**Files:**
- Create: `lib/plan-quality.js`
- Modify: `lib/prompts.js`
- Create: `test/plan-quality.test.js`
- Modify: `test/prompts.test.js`

- [ ] **Step 1: Write failing plan-quality tests**

Add tests that call this wished-for API:

```js
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
  const next = previous.slice(0, 11);
  const result = validatePlanQuality(next, previous);
  assert.ok(result.violations.some(item => item.code === 'plan_page_regression'));
});

test('allows exactly 25 percent loss', () => {
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
  const next = [{ path: 'overview.md', title: 'Overview' }];
  assert.ok(validatePlanQuality(next, previous).violations
    .some(item => item.code === 'plan_topic_regression'));
});

test('acceptPlanShrink bypasses regression but not structure', () => {
  const previous = Array.from({ length: 8 }, (_, i) => ({
    path: i ? `guide-${i}.md` : 'overview.md',
    title: `Page ${i}`,
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
  const pages = [
    { path: 'overview.md', title: 'Overview' },
    {
      path: 'guides/guides.md',
      title: 'Guides',
      _landing: true,
      _children: [{ path: 'guides/start.md', title: 'Start' }],
    },
    { path: 'guides/start.md', title: 'Start' },
  ];
  assert.ok(validatePlanQuality(pages, []).violations
    .some(item => item.code === 'plan_landing_children'));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test test/plan-quality.test.js
```

Expected: failure because `../lib/plan-quality` does not exist.

- [ ] **Step 3: Implement deterministic plan policy**

Create `lib/plan-quality.js` with these exports and behavior:

```js
'use strict';

const { dirOf } = require('./plan');

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
  usage: /\busage|getting[- ]started\b/,
  export: /\bexport(?:ing)?\b/,
  deployment: /\bdeploy(?:ment|ing)?|\\bci\\b/,
});

function pageText(page) {
  return `${page.path || ''} ${page.title || ''}`.toLowerCase()
    .replace(/[_.\\/-]+/g, ' ');
}

function topicKeys(pages) {
  const found = new Set();
  for (const page of pages || []) {
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
    const missing = topicKeys(previous).filter(key => !topicKeys(next).includes(key));
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
  return { ok: violations.length === 0, violations };
}

module.exports = {
  TOPICS,
  previousPlanFromState,
  topicKeys,
  validatePlanQuality,
};
```

Add `repairPlanMessages(scan, previousPages, rejected, violations, opts)` to
`lib/prompts.js`. It must start from `planMessages`, include the rejected JSON,
previous path/title pairs, exact violation codes/messages, and request a full
replacement JSON plan. Export it.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/plan-quality.test.js test/prompts.test.js test/plan.test.js
```

Expected: all plan and prompt tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/plan-quality.js lib/prompts.js test/plan-quality.test.js test/prompts.test.js
git commit -m "feat: reject regressive wiki plans"
```

### Task 2: Detailed provider completion metadata

**Files:**
- Modify: `lib/providers.js`
- Modify: `test/providers.test.js`

- [ ] **Step 1: Write failing provider tests**

Use a temporary `global.fetch` replacement and restore it with `t.after`:

```js
test('chatDetailed returns OpenAI finish reason and usage', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: 'length',
        message: { content: '# Partial' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  });
  const result = await chatDetailed({
    provider: 'openai',
    baseUrl: 'http://mock.test/v1',
    model: 'mock',
  }, [{ role: 'user', content: 'write' }], { retries: 0 });
  assert.deepEqual(result, {
    content: '# Partial',
    finishReason: 'length',
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
});

test('chat remains content-only compatible', async t => {
  // install the same successful fetch response
  assert.equal(await chat(profile, messages, { retries: 0 }), '# Complete');
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/providers.test.js
```

Expected: `chatDetailed is not a function`.

- [ ] **Step 3: Implement provider result objects**

Make each internal provider return:

```js
{
  content,
  finishReason: value || null,
  usage: objectOrNull,
}
```

Rename the retrying public implementation to `chatDetailed`. Preserve:

```js
async function chat(profile, messages, opts = {}) {
  return (await chatDetailed(profile, messages, opts)).content;
}
```

For Ollama, map:

```js
usage: {
  prompt_tokens: data.prompt_eval_count,
  completion_tokens: data.eval_count,
}
```

only when either count is numeric. Export `chatDetailed`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/providers.test.js
```

Expected: all provider tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/providers.js test/providers.test.js
git commit -m "feat: expose provider completion metadata"
```

### Task 3: Semantic completion and command grounding gates

**Files:**
- Modify: `lib/quality.js`
- Modify: `lib/prompts.js`
- Modify: `test/quality.test.js`
- Modify: `test/prompts.test.js`

- [ ] **Step 1: Write failing semantic-quality tests**

Add focused tests using an otherwise valid guide fixture:

```js
test('rejects token-limited completions', () => {
  const result = validatePage(validGuide, {
    page: guidePage,
    attached,
    citationResult: validCitationResult,
    completion: { finishReason: 'length' },
    rawByPath: { 'README.md': 'npm test' },
  });
  assert.ok(result.violations.some(v => v.code === 'completion_truncated'));
});

test('rejects a final section ending mid-sentence', () => {
  const broken = validGuide.replace(/final sentence\\.$/, 'final sentence');
  assert.ok(validatePage(broken, context).violations
    .some(v => v.code === 'incomplete_ending'));
});

test('rejects shell commands absent from attached sources', () => {
  const broken = validGuide.replace(
    'final sentence.',
    '```bash\\nnode test/*.test.js\\n```\\n\\nFinal sentence.'
  );
  const result = validatePage(broken, {
    ...context,
    rawByPath: { 'package.json': '"test":"node --test test/*.test.js"' },
  });
  assert.ok(result.violations.some(v => v.code === 'ungrounded_command'));
});

test('accepts exact source-backed shell commands', () => {
  const grounded = validGuide.replace(
    'final sentence.',
    '```bash\\nnode --test test/*.test.js\\n```\\n\\nFinal sentence.'
  );
  assert.equal(validatePage(grounded, {
    ...context,
    rawByPath: { 'package.json': '"test":"node --test test/*.test.js"' },
  }).violations.some(v => v.code === 'ungrounded_command'), false);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/quality.test.js test/prompts.test.js
```

Expected: semantic violation assertions fail.

- [ ] **Step 3: Implement semantic helpers**

Add and export:

```js
function normalizeEvidence(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function shellCommands(md) {
  const commands = [];
  const pattern = /```(?:bash|sh|shell|console|zsh)\s*\n([\s\S]*?)```/gi;
  for (const match of String(md).matchAll(pattern)) {
    for (const raw of match[1].split('\n')) {
      const line = raw.trim().replace(/^(?:\\$|>)\s+/, '');
      if (!line || line.startsWith('#') || line === '\\') continue;
      commands.push(line.replace(/\\\s*$/, '').trim());
    }
  }
  return commands.filter(Boolean);
}
```

Inside `validatePage`, accept `completion` and `rawByPath`. Reject finish reasons
matching `/^(?:length|max_tokens|token_limit)$/i`. Require complete final text
to end in `[.!?;:)\]}>|`]` or a closing fence. Inspect the last H2 body after
removing structured citation lists; accept at least twenty prose words, a
complete fenced block, a Markdown table, or two list items.

Normalize all attached raw sources and require each extracted command to appear
as a substring. Emit one `ungrounded_command` violation per missing command.

Add to `pageMessages`:

```text
- Shell commands may appear only when the exact command text is visible in the numbered source block. Do not infer or repair commands from general knowledge.
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/quality.test.js test/prompts.test.js
```

Expected: all semantic and existing quality tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/quality.js lib/prompts.js test/quality.test.js test/prompts.test.js
git commit -m "feat: reject truncated and ungrounded pages"
```

### Task 4: Persistent run diagnostics

**Files:**
- Create: `lib/run-diagnostics.js`
- Create: `test/run-diagnostics.test.js`

- [ ] **Step 1: Write failing diagnostics tests**

```js
test('persists plan and page attempt evidence without unsafe paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const diagnostics = createRunDiagnostics(root, {
    runId: '20260729T120000Z-123',
    model: 'mock',
    flags: { prune: false },
  });
  diagnostics.recordPlanAttempt(1, '{"pages":[]}', {
    finishReason: 'stop',
    usage: { completion_tokens: 3 },
    violations: [{ code: 'plan_page_regression' }],
  });
  diagnostics.recordPageAttempt('guides/start.md', 1, '# Draft', {
    finishReason: 'length',
    violations: [{ code: 'completion_truncated' }],
  });
  diagnostics.finish('aborted', { pageFailures: 1 });
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(diagnostics.dir, 'run.json'), 'utf8'
  )).status, 'aborted');
  assert.equal(fs.existsSync(path.join(
    diagnostics.dir, 'pages/guides/start/attempt-1.md'
  )), true);
  assert.throws(
    () => diagnostics.writeText('../escape.txt', 'no'),
    /unsafe diagnostic path/
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/run-diagnostics.test.js
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement diagnostics**

Use `safeManagedPath` and an internal atomic writer. `createRunDiagnostics`
returns:

```js
{
  dir,
  writeText(relative, text),
  writeJson(relative, value),
  recordPlanAttempt(attempt, raw, metadata),
  acceptPlan(plan),
  recordPageAttempt(pagePath, attempt, draft, metadata),
  finish(status, patch),
}
```

Encode a page path by removing `.md` and preserving sanitized directory
segments. Initialize `run.json` with `status: "running"` and timestamps. Never
accept absolute paths or `..`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/run-diagnostics.test.js
```

Expected: diagnostics tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/run-diagnostics.js test/run-diagnostics.test.js
git commit -m "feat: persist generation diagnostics"
```

### Task 5: Staged publication transaction

**Files:**
- Create: `lib/run-transaction.js`
- Create: `test/run-transaction.test.js`

- [ ] **Step 1: Write failing transaction tests**

Cover snapshot, abort, commit, rollback, and symlink rejection:

```js
test('abort leaves live trees byte-identical', t => {
  const fixture = transactionFixture(t);
  const before = snapshotTree(fixture.root);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-1');
  tx.prepare();
  fs.writeFileSync(path.join(tx.stagePath('content'), 'page.md'), 'changed');
  tx.abort();
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test('commit failure rolls every live target back', t => {
  const fixture = transactionFixture(t);
  const before = snapshotTree(fixture.root);
  const tx = createRunTransaction([
    { name: 'content', live: fixture.content },
    { name: 'meta', live: fixture.meta },
  ], 'run-2');
  tx.prepare();
  fs.rmSync(tx.stagePath('meta'), { recursive: true, force: true });
  assert.throws(() => tx.commit());
  assert.deepEqual(snapshotTree(fixture.root), before);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/run-transaction.test.js
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement transaction lifecycle**

`createRunTransaction(targets, runId)` must:

```js
{
  prepare(),
  stagePath(name),
  commit(),
  abort(),
}
```

Derive `.<basename>.stage-<runId>` and `.<basename>.backup-<runId>` as siblings
of each live target. Validate unique, non-overlapping, non-symlinked targets.
`prepare()` copies an existing live directory recursively or creates an empty
stage. `commit()` performs live-to-backup then stage-to-live renames for every
target. Track whether each live or stage moved; on error, remove a newly moved
live target and restore every backup in reverse order. `abort()` removes stages
and restores any backup. All cleanup paths must be derived and containment
checked rather than accepted from callers.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/run-transaction.test.js
```

Expected: transaction tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/run-transaction.js test/run-transaction.test.js
git commit -m "feat: stage and rollback wiki publication"
```

### Task 6: Orchestrate planner retries and transactional page publication

**Files:**
- Modify: `generate.js`
- Modify: `test/mock-llm.js`
- Modify: `test/generate.integration.test.js`

- [ ] **Step 1: Write failing CLI and plan-retry integration tests**

Extend `createMockServer` with:

```js
planResponder({ attempt, defaultPlan }) -> plan or raw string
finishReasonResponder({ kind, title, attempt }) -> string
```

Record `state.planRequests` and include OpenAI `finish_reason` and `usage` in
responses.

Add integration assertions:

```js
const planRequestsBeforeInvalidFlags = server.state.planRequests;
const invalidFlags = await runGenerator(repo, configPath, [
  '--pages', 'overview.md', '--prune',
]);
assert.equal(invalidFlags.code, 1);
assert.match(invalidFlags.stderr, /--pages cannot be combined/);
assert.equal(server.state.planRequests, planRequestsBeforeInvalidFlags);

behavior.planSequence = [collapsedPlan, repairedPlan];
const repairedPlanRun = await runGenerator(repo, configPath);
assert.equal(repairedPlanRun.code, 0, repairedPlanRun.stderr);
assert.equal(server.state.lastPlanRunRequests, 2);

const liveBeforeRejectedPlans = snapshotWiki(repo);
behavior.planSequence = [collapsedPlan, collapsedPlan, collapsedPlan];
const rejectedPlans = await runGenerator(repo, configPath);
assert.equal(rejectedPlans.code, 1);
assert.deepEqual(snapshotWiki(repo), liveBeforeRejectedPlans);
assert.equal(server.state.lastPlanRunRequests, 3);
```

Snapshot live content/meta recursively before the failure and compare every
relative path and byte buffer afterward. Assert the run directory contains all
three raw plans and `plan_page_regression`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/generate.integration.test.js
```

Expected: new flag and plan-retry assertions fail.

- [ ] **Step 3: Add CLI flags and planner retry**

Parse and document:

```js
else if (a === '--prune') args.prune = true;
else if (a === '--accept-plan-shrink') args.acceptPlanShrink = true;
```

Reject incompatible selective/deletion flags immediately after parsing.
Initialize diagnostics before the planner call. Load the previous state/catalog
from live paths and derive the baseline plan. Replace the single planner call
with three attempts using `chatDetailed`, `normalizePlan`,
`validatePlanQuality`, and `repairPlanMessages`. Persist every attempt and the
accepted normalized plan. On exhaustion, finish diagnostics as `aborted` and
exit non-zero without creating a transaction.

- [ ] **Step 4: Stage all page writes and abort on page failure**

Create a transaction for content/meta and requested knowledge, call `prepare`,
then point all writes to the stage paths. Keep separate `liveOutDir`,
`liveMetaDir`, and `liveKnowledgeBase` variables for baseline reads.

Pass `{ finishReason }` and `rawByPath` into `validatePage`, and persist every
draft/violation via diagnostics. After child and landing pools:

```js
if (failed > 0) {
  transaction.abort();
  diagnostics.finish('aborted', { pageFailures: failed });
  process.exit(1);
}
```

This check must precede stale cleanup, catalog, index, state finalization, and
knowledge generation.

- [ ] **Step 5: Implement explicit stale retention/deletion**

Set:

```js
const deleteStale = args.prune || args.acceptPlanShrink;
```

When false, do not delete stage files/state metadata and append omitted previous
metadata to `publishedMetadata` so index/catalog continue advertising retained
pages. When true, delete omitted managed files only inside staged content and
remove their state entries.

Store `lastSuccessfulPlan` and `lastRunId` in schema-3 staged state only after
all generation work succeeds.

- [ ] **Step 6: Verify planner/publication GREEN**

Run:

```bash
node --test test/generate.integration.test.js
```

Expected: plan retry, abort snapshot, and existing integration cases pass.

- [ ] **Step 7: Commit**

```bash
git add generate.js test/mock-llm.js test/generate.integration.test.js
git commit -m "feat: make page generation transactional"
```

### Task 7: Transactional knowledge, commit, prune modes, and full diagnostics

**Files:**
- Modify: `generate.js`
- Modify: `test/mock-llm.js`
- Modify: `test/generate.integration.test.js`

- [ ] **Step 1: Write failing end-to-end transaction tests**

Add cases proving:

```text
page failure -> content/meta/knowledge live snapshot unchanged
knowledge failure -> content/meta/knowledge live snapshot unchanged
default success -> omitted prior page retained and cataloged
--prune success -> omitted prior page deleted after non-regressive plan
--accept-plan-shrink -> regressive plan accepted and omitted page deleted
successful run -> no stage or backup paths remain
failed/successful attempts -> finishReason, violations, and status persisted
```

For prune without regression, replace one old page with one new page so the
count remains above threshold. For accepted shrink, collapse a larger plan and
assert no planner retry occurs.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/generate.integration.test.js
```

Expected: knowledge rollback/prune/commit assertions fail.

- [ ] **Step 3: Stage knowledge and commit the transaction**

Generate requested knowledge only into `transaction.stagePath('knowledge')`.
Use `chatDetailed` and persist card completion metadata. Any knowledge failure
calls `transaction.abort()` and leaves live page output untouched.

After staged state/catalog/index/knowledge all succeed:

```js
transaction.commit();
diagnostics.finish('committed', {
  pageFailures: 0,
  knowledgeFailures: 0,
  publishedPages: publishedMetadata.length,
});
```

Wrap transaction ownership in `try/catch/finally` so unexpected exceptions
abort a prepared but uncommitted transaction before the outer fatal exit.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/generate.integration.test.js
```

Expected: every transaction, prune, diagnostics, and legacy incremental case
passes.

- [ ] **Step 5: Commit**

```bash
git add generate.js test/mock-llm.js test/generate.integration.test.js
git commit -m "feat: commit complete wiki runs atomically"
```

### Task 8: Documentation and completion audit

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-29-transactional-generation-safety-design.md`

- [ ] **Step 1: Update user documentation**

Document:

```text
transactional staging and rollback
default no-delete behavior
--prune
--accept-plan-shrink
--pages incompatibility
.local-wiki/runs diagnostics layout
plan retry threshold
semantic command and truncation gates
schema-3 migration
```

Set the design status to `Implemented` only after tests prove every acceptance
row.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm test
node --check generate.js
node --check export.js
for f in lib/*.js test/*.js; do node --check "$f"; done
node generate.js --help
git diff --check
git status --short --branch
```

Expected: all tests pass, syntax checks are silent, help lists both flags, diff
check is silent, and only intended documentation changes remain before commit.

- [ ] **Step 3: Requirement-by-requirement audit**

Inspect tests rather than relying on their names. Confirm direct evidence:

```text
1 -> failed page and failed knowledge snapshots prove live transactionality
2 -> failure assertions occur before stale cleanup and old files survive
3 -> three-attempt collapse abort plus repaired-plan success
4 -> default retain, --prune delete, --accept-plan-shrink delete
5 -> raw/normalized plan, drafts, violations, finish reason files asserted
6 -> singleton and one-child landing unit/integration rejection
7 -> truncated completion and exact command evidence unit/integration rejection
```

- [ ] **Step 4: Commit docs**

```bash
git add README.md docs/superpowers/specs/2026-07-29-transactional-generation-safety-design.md
git commit -m "docs: explain transactional wiki generation"
```

- [ ] **Step 5: Request final code review**

Review the entire range from the design commit through HEAD, classify findings
as Critical/Important/Minor, remediate Critical/Important findings with new RED
tests, and repeat full verification before branch handoff.
