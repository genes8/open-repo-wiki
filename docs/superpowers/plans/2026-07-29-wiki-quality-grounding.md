# Wiki Quality and Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wiki and knowledge generation reject ungrounded output, guarantee navigation landings, emit validated line-range citations, use bounded evidence-driven page depth, and preserve source-hash incremental behavior.

**Architecture:** Extract deterministic planning, source formatting, quality, and knowledge policies into focused CommonJS modules. Keep `generate.js` as the orchestrator, publishing only validated output and retaining the previous page/state on exhausted repair attempts.

**Tech Stack:** Node.js >=18 built-ins, CommonJS, `node:test`, local HTTP mock provider, JSON/YAML/Markdown filesystem artifacts.

---

## File map

- Create `lib/plan.js`: normalized planner output, hard cap, synthetic landings, parent/group helpers.
- Create `lib/sources.js`: raw source attachment, line-numbered prompt blocks, line-count metadata.
- Create `lib/quality.js`: page profiles and deterministic validation.
- Create `lib/knowledge.js`: knowledge plan, topical signals, card frontmatter, managed manifest cleanup.
- Modify `lib/providers.js`: safe leading-only reasoning stripping and public test export.
- Modify `lib/citations.js`: strict range parsing, bounds checks, structured violation reporting.
- Modify `lib/prompts.js`: depth profiles, line-range instructions, repair prompt, generalized knowledge-card prompt.
- Modify `lib/modules.js`: deterministic semantic module titles.
- Modify `generate.js`: normalized plan, schema-versioned source hash, validate/repair/publish loop, knowledge plan/manifest integration.
- Modify `test/mock-llm.js`: importable ephemeral server and deterministic invalid-first repair behavior.
- Create focused `test/*.test.js` unit/integration suites.
- Modify `package.json`: built-in test command.
- Modify `README.md`: new guarantees and commands.

### Task 1: Test harness and safe reasoning removal

**Files:**
- Modify: `package.json`
- Create: `test/providers.test.js`
- Modify: `lib/providers.js:19-23,159`

- [ ] **Step 1: Add the built-in test command**

Add this script without adding a dependency:

```json
"test": "node --test test/*.test.js"
```

- [ ] **Step 2: Write the failing provider regression tests**

Create `test/providers.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripThink } = require('../lib/providers');

test('stripThink removes complete reasoning blocks only at the start', () => {
  assert.equal(
    stripThink('  <think>private reasoning</think>\\n<think>more</think>\\nFinal answer'),
    'Final answer'
  );
});

test('stripThink preserves literal think examples after answer content begins', () => {
  const text = 'Document `<think>reasoning</think>` exactly.';
  assert.equal(stripThink(text), text);
});

test('stripThink returns empty text for an all-reasoning response', () => {
  assert.equal(stripThink('<think>private reasoning</think>'), '');
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test --test-name-pattern=stripThink test/providers.test.js`

Expected: FAIL because `stripThink` is not exported and the inline example is removed by the current global replacement.

- [ ] **Step 4: Implement the minimal leading-only removal**

Change `lib/providers.js` to:

```js
function stripThink(text) {
  let out = String(text);
  const leading = /^\s*<think>[\s\S]*?<\/think>\s*/;
  while (leading.test(out)) out = out.replace(leading, '');
  return out.trim();
}

module.exports = { chat, resolveApiKey, PROVIDERS, stripThink };
```

- [ ] **Step 5: Run the provider tests and full suite**

Run: `npm test`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/providers.js test/providers.test.js
git commit -m "fix: preserve literal think tags in generated docs"
```

### Task 2: Deterministic plan validation and guaranteed landings

**Files:**
- Create: `lib/plan.js`
- Create: `test/plan.test.js`
- Modify later: `generate.js`

- [ ] **Step 1: Write failing plan-normalization tests**

Create `test/plan.test.js` with a real `Set`-backed scan:

```js
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
    /overview\\.md/
  );
});

test('groupPages returns stable directory groups', () => {
  const pages = [{ path: 'overview.md' }, { path: 'guides/a.md' }, { path: 'guides/b.md' }];
  assert.equal(dirOf('guides/a.md'), 'guides');
  assert.deepEqual([...groupPages(pages).keys()], ['', 'guides']);
});
```

- [ ] **Step 2: Run the plan tests and verify RED**

Run: `node --test test/plan.test.js`

Expected: FAIL with `Cannot find module '../lib/plan'`.

- [ ] **Step 3: Implement `lib/plan.js`**

Implement and export:

```js
sanitizePagePath(value)
dirOf(pagePath)
baseNoExt(pagePath)
groupPages(pages)
normalizePlan(rawPages, scan, { maxPages })
```

`normalizePlan` must:

```js
// 1. sanitize, dedupe, validate title, and filter files through scan.fileSet
// 2. require overview.md and move it to index 0
// 3. annotate explicit dir/dir.md and dir/index.md landings
// 4. synthesize missing landings with stable union(child.files).slice(0, 6)
// 5. while final pages exceed maxPages, remove the last non-overview,
//    non-explicit-landing content page and recompute required landings
// 6. order every directory landing after its final child
// 7. return { pages, groups, landingByDir, parentByPath }
```

Synthetic landing metadata must use:

```js
{
  path: `${dir}/${dir.split('/').at(-1)}.md`,
  title: titleCase(dir.split('/').at(-1)),
  description: `Overview and navigation for the ${title} section.`,
  files,
  _landing: true,
  _synthetic: true,
  _children: children,
}
```

Explicit landings receive `_landing`, `_children`, and `_desc0` without changing their planned path.

- [ ] **Step 4: Run plan tests and full suite**

Run: `npm test`

Expected: all plan/provider tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/plan.js test/plan.test.js
git commit -m "feat: validate plans and guarantee landing pages"
```

### Task 3: Line-numbered sources and strict citation ranges

**Files:**
- Create: `lib/sources.js`
- Create: `test/sources.test.js`
- Modify: `lib/citations.js`
- Create: `test/citations.test.js`

- [ ] **Step 1: Write failing source-block tests**

Create `test/sources.test.js` using `fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-sources-'))`. Write `a.js` with three lines and assert:

```js
const result = buildFilesBlock(repo, { files: ['a.js', 'missing.js'] }, scan, 1000);
assert.deepEqual(result.attached, ['a.js']);
assert.equal(result.lineCounts['a.js'], 3);
assert.match(result.block, /L1: one\\nL2: two\\nL3: three/);
assert.equal(result.rawByPath['a.js'], 'one\\ntwo\\nthree\\n');
```

- [ ] **Step 2: Write failing citation-range tests**

Create `test/citations.test.js` and cover:

```js
const attached = ['lib/a.js'];
const lineCounts = { 'lib/a.js': 20 };

// valid whole-file cite and valid ranged section citation survive
// lib/a.js#L2-L8 is counted in validRanges
// lib/a.js#L2-8 reports citation_range_format
// lib/a.js#L8-L2 reports citation_range_order
// lib/a.js#L1-L99 reports citation_range_bounds
// lib/missing.js#L1-L2 reports citation_unattached
// a marker with no surviving bullets is removed
```

Assert the return contract:

```js
{
  md: String,
  dropped: Number,
  violations: [{ code, target, message }],
  validRanges: Number
}
```

- [ ] **Step 3: Run source/citation tests and verify RED**

Run: `node --test test/sources.test.js test/citations.test.js`

Expected: FAIL because `lib/sources.js` and strict range validation do not exist.

- [ ] **Step 4: Implement `lib/sources.js`**

Move the existing attachment budget logic from `generate.js` and return:

```js
{ block, attached, lineCounts, rawByPath }
```

Number displayed lines with `L${index + 1}: ` after truncating by character budget. Compute `lineCounts` from the full raw content so a citation can never exceed the actual file.

- [ ] **Step 5: Extend `lib/citations.js`**

Add:

```js
function parseRangeTarget(target) {
  const m = String(target).match(/^(?:file:\\/\\/)?([^#]+)#L(\\d+)-L(\\d+)$/);
  return m ? { path: m[1].trim(), start: Number(m[2]), end: Number(m[3]) } : null;
}
```

Inside `<cite>`, validate only the normalized path. Inside section/diagram lists, require `parseRangeTarget`, attached membership, ordered positive lines, and `end <= lineCounts[path]`. Return violations instead of clamping.

- [ ] **Step 6: Run focused and full tests**

Run: `npm test`

Expected: source/provider/plan/citation tests all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/sources.js lib/citations.js test/sources.test.js test/citations.test.js
git commit -m "feat: validate source citation line ranges"
```

### Task 4: Bounded page profiles and deterministic quality gates

**Files:**
- Create: `lib/quality.js`
- Create: `test/quality.test.js`

- [ ] **Step 1: Write failing quality tests**

Create a `validPage({ title, sections, words, citation, children })` helper in `test/quality.test.js`. Add one test per violation:

```js
refusal_text
h1_count
h1_title
empty_inline_code
section_count
word_count
mermaid_count
unbalanced_fence
missing_cite
missing_range_citation
landing_child_link
```

Also assert profile classification:

```js
assert.equal(classifyPage({ path: 'architecture/data-flow.md' }).name, 'architecture');
assert.equal(classifyPage({ path: 'guides/start.md' }).name, 'guide');
assert.equal(classifyPage({ path: 'guides/guides.md', _landing: true }).name, 'landing');
assert.equal(classifyPage({ path: 'overview.md' }).name, 'overview');
```

- [ ] **Step 2: Run quality tests and verify RED**

Run: `node --test test/quality.test.js`

Expected: FAIL with `Cannot find module '../lib/quality'`.

- [ ] **Step 3: Implement `lib/quality.js`**

Export:

```js
PAGE_PROFILES
classifyPage(page)
pageStats(md)
validatePage(md, { page, attached, citationResult })
```

Use the exact profile bounds from the design spec. Count H2 with `/^##\\s+/gm`, words after removing code fences and tags, Mermaid blocks with `/```mermaid\\b/g`, and all fences with `/^```/gm`. Refusal matching must include apology, file/tool access failure, inability to proceed, and requests for the user to provide source files.

`validatePage` returns:

```js
{ ok: violations.length === 0, violations, stats, profile }
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/quality.js test/quality.test.js
git commit -m "feat: gate generated page quality"
```

### Task 5: Depth-aware, ranged, repairable prompts

**Files:**
- Modify: `lib/prompts.js`
- Create: `test/prompts.test.js`

- [ ] **Step 1: Write failing prompt tests**

Assert `pageMessages`:

```js
// includes the selected profile's H2/word/diagram bounds
// requires [path:Lx-Ly](path#Lx-Ly) in Section/Diagram sources
// keeps top <cite> entries as whole-file links
// says unsupported sections and diagrams must be omitted
```

Assert `repairPageMessages(...)`:

```js
// includes rejected Markdown
// includes stable violation codes/messages
// requests a complete replacement document
// includes the same numbered source block and original page focus
```

- [ ] **Step 2: Run prompt tests and verify RED**

Run: `node --test test/prompts.test.js`

Expected: FAIL because repair prompts/profile instructions do not exist.

- [ ] **Step 3: Implement prompt changes**

Change the API to:

```js
pageMessages(scan, page, filesBlock, { language, attached, template, profile })
repairPageMessages(scan, page, filesBlock, rejected, violations, opts)
knowledgeMessages(scan, card, filesBlock, opts)
```

The standard citation example must be generated from attached paths:

```markdown
- [lib/a.js:L1-L10](lib/a.js#L1-L10)
```

The actual range is chosen from numbered source lines by the model; prompt text must forbid guessed/out-of-bounds ranges.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts.js test/prompts.test.js
git commit -m "feat: add depth-aware repair prompts"
```

### Task 6: Semantic, topical, deduplicated knowledge planning

**Files:**
- Modify: `lib/modules.js`
- Create: `lib/knowledge.js`
- Create: `test/knowledge.test.js`

- [ ] **Step 1: Write failing semantic-title and knowledge-plan tests**

Cover:

```js
assert.equal(semanticModuleTitle('lib'), 'Core Libraries');
assert.equal(semanticModuleTitle('tests'), 'Test Suite');
assert.equal(semanticModuleTitle('custom-tools'), 'Custom Tools');
```

Build a scan with config, package, console, try/catch, and throw signals. Assert:

```js
// exactly one module card per module/card kind
// exactly one topic each for configuration, error_handling, logging, dependency_management
// stable unique identities
// topic source_files are real scan paths
// renderFrontmatter emits kind/category/name/scope/source_files
```

For manifest cleanup, create one managed stale file and one unmanaged note. Assert `cleanupManagedKnowledge` removes only the stale managed file and leaves the note.

- [ ] **Step 2: Run knowledge tests and verify RED**

Run: `node --test test/knowledge.test.js`

Expected: FAIL because semantic titles and `lib/knowledge.js` do not exist.

- [ ] **Step 3: Add semantic module titles**

Export `semanticModuleTitle` from `lib/modules.js` with a frozen common-directory map and `titleCase` fallback. Use it in `moduleMap`.

- [ ] **Step 4: Implement `lib/knowledge.js`**

Export:

```js
buildKnowledgePlan(scan, modules, cardKinds)
detectTopics(scan)
cardIdentity(card)
renderFrontmatter(card)
loadManifest(baseDir)
writeManifest(baseDir, files)
cleanupManagedKnowledge(baseDir, previousFiles, nextFiles)
```

Topic detection must inspect file paths plus textual evidence from `scan.keyFiles` and readable files explicitly supplied by the orchestrator. Deduplicate with `Map(cardIdentity(card), card)`.

- [ ] **Step 5: Run focused and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/modules.js lib/knowledge.js test/knowledge.test.js
git commit -m "feat: generate semantic deduplicated knowledge plans"
```

### Task 7: Integrate validation, repair, atomic publish, and knowledge manifests

**Files:**
- Modify: `generate.js`
- Modify: `test/mock-llm.js`
- Create: `test/generate.integration.test.js`

- [ ] **Step 1: Write the failing end-to-end test**

The test must:

1. create a temporary repository with `README.md`, `package.json`, `lib/a.js`, `guides.md`, and config;
2. start the imported mock server on port `0`;
3. return a plan without landing pages;
4. return refusal text on the first request for one page and valid replacement Markdown on repair;
5. run `generate.js` with `--knowledge`;
6. assert exit `0`, one repair request, generated landing, complete child links, valid catalog parents, in-bounds range citations, semantic module title, topical cards, frontmatter, unique manifest entries;
7. save a page, configure all repair responses to fail, change a source, rerun, assert non-zero exit and byte-identical last-known-good page;
8. restore valid responses, rerun, then run once more unchanged and assert `SKIP` for every page.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `node --test test/generate.integration.test.js`

Expected: FAIL because the mock is not importable/ephemeral and orchestration lacks normalization/quality repair.

- [ ] **Step 3: Refactor the mock server**

Export:

```js
createMockServer({ plan, pageResponder, knowledgeResponder, delay = 0 })
```

When executed directly, keep the current CLI behavior and use `MOCK_PORT || 8688`. The returned server exposes request counters through a shared state object.

- [ ] **Step 4: Integrate normalized planning**

Replace the inline plan sanitation and landing detection in `generate.js` with:

```js
const normalized = normalizePlan(plan.pages, scan, { maxPages });
const pages = normalized.pages;
const pagesByDir = normalized.groups;
```

Use `normalized.landingByDir` and `normalized.parentByPath` for catalog/index output.

- [ ] **Step 5: Integrate numbered sources and schema-versioned hashing**

Add:

```js
const GENERATION_SCHEMA_VERSION = 2;
```

Use `buildFilesBlock` from `lib/sources` and include the schema version in the existing raw-source-backed hash. Never hash numbered prompt text instead of raw source content.

- [ ] **Step 6: Integrate validate/repair/publish**

For each page:

```js
for (let attempt = 0; attempt < 3; attempt++) {
  const messages = attempt === 0
    ? pageMessages(...)
    : repairPageMessages(..., md, validation.violations, ...);
  md = unwrapMarkdown(await chat(...));
  citationResult = sanitizeCitations(md, attached, lineCounts);
  md = citationResult.md;
  validation = validatePage(md, { page, attached, citationResult });
  if (validation.ok) break;
}
```

Write to `${outFile}.tmp-${process.pid}`, rename only after validation, and remove the temp file in `finally`. Update `state.pages[page.path]` only after rename.

- [ ] **Step 7: Integrate knowledge plan/frontmatter/manifest**

Replace the fixed nested loops with `buildKnowledgePlan`. Generate every unique card using its selected sources, prepend `renderFrontmatter`, validate refusal/empty output, and collect relative managed paths. Only after all required cards finish:

```js
cleanupManagedKnowledge(knowledgeBase, previousManifest.files, nextFiles);
writeManifest(knowledgeBase, nextFiles);
```

Keep `_index.yaml` and `_module.yaml` in the managed manifest.

- [ ] **Step 8: Run integration and full tests**

Run:

```bash
npm test
node --check generate.js
for f in lib/*.js test/*.js; do node --check "$f"; done
```

Expected: all tests and syntax checks pass.

- [ ] **Step 9: Commit**

```bash
git add generate.js test/mock-llm.js test/generate.integration.test.js
git commit -m "feat: publish only validated grounded wiki output"
```

### Task 8: Documentation and completion audit

**Files:**
- Modify: `README.md`
- Modify if evidence requires: tests or implementation files above

- [ ] **Step 1: Update README behavior**

Document:

- automatic landing synthesis and hard final `maxPages`;
- bounded page profiles without mandatory section names;
- top whole-file citations versus ranged section/diagram citations;
- two repair attempts and last-known-good preservation;
- generation schema version plus source-hash incremental behavior;
- semantic/topical knowledge cards and managed-manifest cleanup;
- `npm test` as the authoritative local test command.

- [ ] **Step 2: Run the requirement-by-requirement completion audit**

Map every design acceptance criterion to a named test and inspect the actual output artifact from the integration test. Add a failing test before any remediation code if evidence reveals a gap.

- [ ] **Step 3: Run fresh final verification**

Run:

```bash
npm test
node --check generate.js
node --check export.js
for f in lib/*.js test/*.js; do node --check "$f"; done
git diff --check
git status --short
```

Expected: all tests pass, syntax checks exit 0, no whitespace errors, and only intended tracked changes remain.

- [ ] **Step 4: Verify original worktree preservation**

Run:

```bash
git -C /Users/enes/Desktop/Dev/open-repo-wiki status --short
```

Expected: the user's pre-existing `.gitignore`, `config.json`, `generate.js`, and `.env.example` changes remain outside feature commits.

- [ ] **Step 5: Commit docs and final test adjustments**

```bash
git add README.md
git commit -m "docs: explain grounded quality guarantees"
```

- [ ] **Step 6: Invoke finishing-a-development-branch**

Present the verified branch/merge options without merging, pushing, or cleaning the worktree unless explicitly authorized.
