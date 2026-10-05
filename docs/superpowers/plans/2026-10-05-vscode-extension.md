# VSCode Extension Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VSCode extension that generates, browses, modifies, and protects the engine's wiki (Plan A surface: `--json-events` NDJSON, catalog.json, modify ops, wiki_plan) inside the editor, with PDF export — self-contained `.vsix` installable locally.

**Architecture:** TypeScript extension in `extension/`, strict separation between `src/pure/*` (no vscode imports — unit-tested with node:test after tsc) and vscode glue (tree view, webview preview, commands, status bar). The engine runs as a child process (system Node) speaking NDJSON; never imported in-process (native-module ABI). esbuild bundles `src/extension.ts` → `dist/extension.js` and bundles the engine (`generate.js`, `export.js`) into `dist/engine/*.cjs`. Webview assets (marked 4, highlight.js 11, mermaid 10) are copied into `dist/webview/`.

**Tech Stack:** TypeScript 5 (strict), esbuild, @types/vscode ^1.80, node:test for pure units, marked@4.3.0 + highlight.js@11.9.0 + mermaid@10.9.0 (vendored, UMD), @vscode/vsce for packaging.

**Spec:** `docs/superpowers/specs/2026-10-04-vscode-extension-parity-design.md` (sections 4–6)
**Engine handoff:** final-review notes — event contract (27 types, all carry `ts`), catalog fields (`path,title,description,dependent_files,parent,isLanding,quality,protected`), ApiError codes, SIGTERM leaves stage dirs (one run at a time), `configPath` programmatic option, stdout is pure NDJSON in `--json-events` mode.

**Worktree:** `.worktrees/extension` on branch `feature/vscode-extension` from `main`.

---

## Engine facts the extension must respect (verified on main)

- CLI: `node generate.js <repoDir> --json-events [-m profile] [-o outDir] [--config file] [--force] [--knowledge]` and `--modify <path> --op modify|supplement|rewrite --instruction "<text>"`, `--list-models --json-events`.
- Out layout: `-o <repo>/.local-wiki/<lang>/content` (structured); catalog at `<lang>/meta/catalog.json`.
- Every NDJSON event: `{ type, ts, ...payload }`. Key types: `run_started{repo,model,provider,modelId,configPath,outDir,mode?}`, `env_loaded{count}`, `scan_started{}`, `scan_done{files}`, `scan_warning{message}`, `plan_file_loaded{file,documents,scope{include,exclude}}`, `plan_started{}`, `plan_retry{attempt,codes}`, `plan_ready{pages[{path,title}],coverage,strict?}`, `dry_run{}`, `page_start{path}`, `page_retry{path,attempt,codes}`, `page_note{path,message}`, `page_done{path,status:generated|degraded|protected|skipped,chars?,files?,reason?,codes?,operation?}`, `page_fail{path,message}`, `stale_removed{path}`, `catalog_written{metaDir}`, `knowledge_started{}`, `knowledge_card_fail{path,message}`, `knowledge_done{generated,duplicates,removed,dir}`, `knowledge_failed_run{failed}`, `run_note{message}`, `run_aborted{ok,skipped,failed,subject}`, `run_finished{stats{generated,degraded,skipped,failed,knowledgeFailed},outDir,tip}`, `run_error{code,message}`, `cleanup_warning{target,message}`, `model_profile{name,default,provider,model}`.
- `run_error` is emitted by the CLI as the LAST event on failure (exit 1).

## File map

```
extension/
├── package.json                 # manifest: commands, views, settings, menus
├── tsconfig.json                # strict, noEmit for typecheck
├── tsconfig.test.json           # builds src+test → out-test/
├── build.mjs                    # esbuild bundles + vendor copy + webview copy
├── .gitignore                   # dist/, out-test/, node_modules/, *.vsix
├── .vscodeignore                # vsce excludes
├── media/icon.svg               # activity-bar icon
├── webview/page.html|page.css|webview.js   # preview panel sources (copied to dist)
├── src/
│   ├── pure/events.ts           # WikiEvent union + line parser          [T2]
│   ├── pure/paths.ts            # wikiPaths layout                       [T2]
│   ├── pure/catalog.ts          # catalog types + reader                 [T2]
│   ├── pure/treeModel.ts        # catalog → tree nodes                   [T2]
│   ├── pure/progress.ts         # event → progress mapping               [T2]
│   ├── pure/args.ts             # engine argv builders                   [T2]
│   ├── pure/planScaffold.ts     # wiki_plan template                     [T2]
│   ├── engineRunner.ts          # spawn/NDJSON/cancel/single-flight      [T3]
│   ├── enginePaths.ts           # engine entry resolution order          [T3]
│   ├── wikiTree.ts              # TreeDataProvider                        [T4]
│   ├── preview.ts               # webview panel manager                   [T5]
│   ├── statusBar.ts             # update-available item                   [T7]
│   ├── changeDetector.ts        # save-watch + dependent-file index       [T7]
│   └── extension.ts             # activate: wires everything              [T4→T8]
└── test/                        # node:test units for pure/* (+runner e2e in T3)
    ├── events.test.ts, paths.test.ts, catalog.test.ts, treeModel.test.ts,
    ├── progress.test.ts, args.test.ts, runner.e2e.test.ts
```

Conventions: TS strict; `pure/*` files MUST NOT import 'vscode'. Glue files keep logic thin and delegate to pure helpers. Every task ends green: `npm run typecheck` + `npm test` (inside `extension/`) + commit.

---

### Task 1: Scaffold + build tooling

**Files:** everything listed above except src modules beyond a stub; media/icon.svg; build.mjs; tsconfigs; .gitignore; .vscodeignore.

- [ ] **Step 1: Create `extension/package.json`** (complete):

```json
{
  "name": "open-repo-wiki",
  "displayName": "Open Repo Wiki",
  "description": "Generate, browse, and edit an AI documentation wiki for any repository — works with any LLM backend.",
  "version": "0.1.0",
  "publisher": "genes8",
  "license": "MIT",
  "engines": { "vscode": "^1.80.0" },
  "categories": ["Other", "AI", "Documentation"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "openRepoWiki.generate", "title": "Repo Wiki: Generate / Update Wiki", "icon": "$(play)" },
      { "command": "openRepoWiki.refreshTree", "title": "Repo Wiki: Refresh", "icon": "$(refresh)" },
      { "command": "openRepoWiki.openSettings", "title": "Repo Wiki: Settings", "icon": "$(gear)" },
      { "command": "openRepoWiki.selectLanguage", "title": "Repo Wiki: Select Language", "icon": "$(globe)" },
      { "command": "openRepoWiki.modifyPage", "title": "Repo Wiki: Modify Page…", "icon": "$(edit)" },
      { "command": "openRepoWiki.editPlan", "title": "Repo Wiki: Edit wiki_plan.yaml" },
      { "command": "openRepoWiki.exportPdf", "title": "Repo Wiki: Export to PDF", "icon": "$(file-pdf)" },
      { "command": "openRepoWiki.selectModel", "title": "Repo Wiki: Select Model Profile" },
      { "command": "openRepoWiki.showOutput", "title": "Repo Wiki: Show Engine Output" }
    ],
    "viewsContainers": {
      "activitybar": [{ "id": "open-repo-wiki", "title": "Repo Wiki", "icon": "media/icon.svg" }]
    },
    "views": {
      "open-repo-wiki": [{ "type": "tree", "id": "openRepoWiki.pages", "name": "Wiki Pages" }]
    },
    "viewsWelcome": [
      {
        "view": "openRepoWiki.pages",
        "contents": "No wiki found for this workspace.\n[Generate Wiki](command:openRepoWiki.generate)\nTo learn more, [open settings](command:openRepoWiki.openSettings)."
      }
    ],
    "menus": {
      "view/title": [
        { "command": "openRepoWiki.generate", "when": "view == openRepoWiki.pages", "group": "navigation@1" },
        { "command": "openRepoWiki.refreshTree", "when": "view == openRepoWiki.pages", "group": "navigation@2" },
        { "command": "openRepoWiki.selectLanguage", "when": "view == openRepoWiki.pages", "group": "navigation@3" },
        { "command": "openRepoWiki.openSettings", "when": "view == openRepoWiki.pages", "group": "navigation@4" }
      ],
      "view/item/context": [
        { "command": "openRepoWiki.modifyPage", "when": "view == openRepoWiki.pages && viewItem == page", "group": "inline@1" },
        { "command": "openRepoWiki.exportPdf", "when": "view == openRepoWiki.pages", "group": "inline@2" }
      ]
    },
    "configuration": {
      "title": "Open Repo Wiki",
      "properties": {
        "openRepoWiki.defaultModel": { "type": "string", "default": "", "description": "Model profile from the engine config (empty = engine default)." },
        "openRepoWiki.language": { "type": "string", "default": "en", "description": "Wiki output language (used for the .local-wiki/<lang> directory)." },
        "openRepoWiki.configPath": { "type": "string", "default": "", "description": "Path to a repo-wiki.config.json (empty = engine auto-discovery)." },
        "openRepoWiki.enginePath": { "type": "string", "default": "", "description": "Full engine install (folder containing generate.js). Empty = monorepo checkout or bundled engine." },
        "openRepoWiki.nodePath": { "type": "string", "default": "", "description": "Node binary for the engine child process (empty = node from PATH, then VSCode's builtin)." },
        "openRepoWiki.autoUpdate": { "type": "string", "enum": ["notify", "auto", "off"], "default": "notify", "description": "What to do when a saved source file belongs to a wiki page: show a status-bar hint, auto-run generation, or nothing." }
      }
    }
  },
  "scripts": {
    "compile": "node build.mjs",
    "watch": "node build.mjs --watch",
    "typecheck": "tsc -p tsconfig.json",
    "test": "tsc -p tsconfig.test.json && node --test out-test/test/",
    "package": "npm run compile && vsce package"
  },
  "devDependencies": {
    "@types/node": "^18.19.0",
    "@types/vscode": "^1.80.0",
    "@vscode/vsce": "^2.26.0",
    "esbuild": "^0.21.0",
    "highlight.js": "11.9.0",
    "marked": "4.3.0",
    "mermaid": "10.9.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `extension/tsconfig.json`**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "strict": true,
    "noUnusedLocals": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["test/**", "node_modules"]
}
```

- [ ] **Step 3: Create `extension/tsconfig.test.json`**:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "out-test",
    "types": ["node"],
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Note: tsconfig.json has noEmit default false with outDir dist — `npm run typecheck` runs `tsc -p tsconfig.json` which EMITS to dist; that's fine (build.mjs overwrites with the bundle). Alternatively set `"noEmit": true` in tsconfig.json — do that, cleaner: add `"noEmit": true` to tsconfig.json compilerOptions.

- [ ] **Step 4: Create `extension/build.mjs`** (complete):

```js
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const engineRoot = resolve(root, '..');
const watch = process.argv.includes('--watch');

mkdirSync(join(root, 'dist', 'webview'), { recursive: true });

// 1) The extension host bundle.
await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: join(root, 'dist', 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  ...(watch ? { watch: true } : {}),
});

// 2) The engine bundles (self-contained; optional natives fail at runtime via
//    their own try/catch paths exactly like an install without them).
for (const [entry, outfile] of [
  [join(engineRoot, 'generate.js'), 'generate.cjs'],
  [join(engineRoot, 'export.js'), 'export.cjs'],
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: join(root, 'dist', 'engine', outfile),
    external: ['node-llama-cpp'],
    format: 'cjs',
    platform: 'node',
    target: 'node16',
    sourcemap: false,
    banner: { js: "const __non_webpack_require__ = require;" },
    logLevel: 'info',
  });
}

// 3) Vendored webview assets (UMD builds shipped as static files).
const vendor = join(root, 'node_modules');
const webview = join(root, 'dist', 'webview');
for (const [from, to] of [
  [join(vendor, 'marked', 'lib', 'marked.umd.js'), 'marked.js'],
  [join(vendor, 'highlight.js', 'lib', 'index.js'), 'highlight.js'],
  [join(vendor, 'highlight.js', 'styles', 'github.css'), 'highlight.css'],
  [join(vendor, 'mermaid', 'dist', 'mermaid.min.js'), 'mermaid.js'],
]) {
  cpSync(from, join(webview, to));
}

// 4) Our webview sources (html/css/glue).
for (const file of ['page.html', 'page.css', 'webview.js']) {
  cpSync(join(root, 'webview', file), join(webview, file));
}
console.log('build complete: dist/extension.js, dist/engine/*, dist/webview/*');
```

- [ ] **Step 5: Create `extension/media/icon.svg`** (complete):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/>
  <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-2.5"/>
  <path d="M9 7.5h7M9 11h7"/>
</svg>
```

- [ ] **Step 6: Create `extension/webview/page.html`, `page.css`, `webview.js`** as minimal placeholders now (real content lands in Task 5 — create empty-ish files so build.mjs's copy step works):

`webview/page.html`:
```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Repo Wiki Preview</title></head>
<body><div id="page">preview placeholder — implemented in Task 5</div></body>
</html>
```
`webview/page.css`: `/* Task 5 */`
`webview/webview.js`: `/* Task 5 */`

- [ ] **Step 7: Create `extension/src/extension.ts` stub**:

```ts
import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // Wired up task by task: tree (T4), preview (T5), commands (T3/T6), change detection (T7).
}

export function deactivate(): void {
  // Engine child termination lands in Task 3.
}
```

- [ ] **Step 8: `.gitignore` + `.vscodeignore`**:

`.gitignore`:
```
node_modules/
dist/
out-test/
*.vsix
```
`.vscodeignore`:
```
.vscode/**
src/**
test/**
webview/**
out-test/**
node_modules/**
tsconfig*.json
build.mjs
**/*.map
```

- [ ] **Step 9: Install + verify build:**

```bash
cd extension && npm install && npm run compile && npm run typecheck
```
Expected: esbuild prints 3 bundles written; dist/webview contains 8 files (4 vendor + 3 ours — count them with `ls`); tsc exits 0.

- [ ] **Step 10: Commit** (from repo root): `git add extension && git commit -m "feat: scaffold vscode extension with esbuild engine bundling"`

---

### Task 2: Pure core (events, paths, catalog, tree, progress, args, scaffold)

**Files:** `src/pure/*.ts` + `test/*.test.ts` (except runner e2e). Strict TDD per module: test → red → implement → green.

- [ ] **Step 1: `test/events.test.ts`** then **`src/pure/events.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNdjsonLine, isWikiEvent } from '../src/pure/events.js';

test('parses valid NDJSON lines into typed events', () => {
  const e = parseNdjsonLine('{"type":"page_done","ts":"2026-10-05T00:00:00Z","path":"a.md","status":"generated","chars":10,"files":2}');
  assert.ok(e);
  assert.equal(e.type, 'page_done');
  if (e.type === 'page_done') {
    assert.equal(e.path, 'a.md');
    assert.equal(e.status, 'generated');
    assert.equal(e.chars, 10);
    assert.equal(e.files, 2);
  }
});

test('rejects malformed lines and non-events', () => {
  assert.equal(parseNdjsonLine('not json'), null);
  assert.equal(parseNdjsonLine('{"type":"nope","ts":"x"}'), null);
  assert.equal(parseNdjsonLine('{"type":"page_done"}'), null); // missing ts
  assert.equal(parseNdjsonLine(''), null);
  assert.equal(parseNdjsonLine('{"type":123,"ts":"x"}'), null);
});

test('isWikiEvent accepts all 27 documented types', () => {
  const types = ['run_started','env_loaded','scan_started','scan_done','scan_warning',
    'plan_file_loaded','plan_started','plan_retry','plan_ready','dry_run','page_start',
    'page_retry','page_note','page_done','page_fail','stale_removed','catalog_written',
    'knowledge_started','knowledge_card_fail','knowledge_done','knowledge_failed_run',
    'run_note','run_aborted','run_finished','run_error','cleanup_warning','model_profile'];
  for (const t of types) {
    assert.ok(isWikiEvent({ type: t, ts: 'x' }), t);
  }
});
```

`src/pure/events.ts` (complete — the contract from lib/events.js):

```ts
export type PageStatus = 'generated' | 'degraded' | 'protected' | 'skipped';
export type PageDoneEvent = { type: 'page_done'; ts: string; path: string; status: PageStatus; chars?: number; files?: number; reason?: string; codes?: string; operation?: string };
export type WikiEvent =
  | { type: 'run_started'; ts: string; repo?: string; model?: string; provider?: string; modelId?: string; configPath?: string; outDir?: string; mode?: string }
  | { type: 'env_loaded'; ts: string; count: number }
  | { type: 'scan_started'; ts: string }
  | { type: 'scan_done'; ts: string; files: number }
  | { type: 'scan_warning'; ts: string; message: string }
  | { type: 'plan_file_loaded'; ts: string; file?: string; documents?: number; scope?: { include: number; exclude: number } }
  | { type: 'plan_started'; ts: string }
  | { type: 'plan_retry'; ts: string; attempt?: number; codes?: string }
  | { type: 'plan_ready'; ts: string; pages?: Array<{ path: string; title: string }>; coverage?: number; strict?: boolean }
  | { type: 'dry_run'; ts: string }
  | { type: 'page_start'; ts: string; path?: string }
  | { type: 'page_retry'; ts: string; path?: string; attempt?: number; codes?: string }
  | { type: 'page_note'; ts: string; path?: string; message?: string }
  | PageDoneEvent
  | { type: 'page_fail'; ts: string; path?: string; message?: string }
  | { type: 'stale_removed'; ts: string; path?: string }
  | { type: 'catalog_written'; ts: string; metaDir?: string }
  | { type: 'knowledge_started'; ts: string }
  | { type: 'knowledge_card_fail'; ts: string; path?: string; message?: string }
  | { type: 'knowledge_done'; ts: string; generated?: number; duplicates?: number; removed?: number; dir?: string }
  | { type: 'knowledge_failed_run'; ts: string; failed?: number }
  | { type: 'run_note'; ts: string; message?: string }
  | { type: 'run_aborted'; ts: string; ok?: number; skipped?: number; failed?: number; subject?: string }
  | { type: 'run_finished'; ts: string; stats?: { generated: number; degraded: number; skipped: number; failed: number; knowledgeFailed: number }; outDir?: string; tip?: string }
  | { type: 'run_error'; ts: string; code?: string; message?: string }
  | { type: 'cleanup_warning'; ts: string; target?: string; message?: string }
  | { type: 'model_profile'; ts: string; name?: string; default?: boolean; provider?: string; model?: string };

const TYPES: ReadonlySet<string> = new Set([
  'run_started','env_loaded','scan_started','scan_done','scan_warning','plan_file_loaded',
  'plan_started','plan_retry','plan_ready','dry_run','page_start','page_retry','page_note',
  'page_done','page_fail','stale_removed','catalog_written','knowledge_started',
  'knowledge_card_fail','knowledge_done','knowledge_failed_run','run_note','run_aborted',
  'run_finished','run_error','cleanup_warning','model_profile',
]);

export function isWikiEvent(value: unknown): value is WikiEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && TYPES.has(v.type) && typeof v.ts === 'string' && v.ts.length > 0;
}

export function parseNdjsonLine(line: string): WikiEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isWikiEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: `test/paths.test.ts`** then **`src/pure/paths.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiPaths } from '../src/pure/paths.js';
import * as path from 'node:path';

test('wikiPaths mirrors the engine output layout', () => {
  const p = wikiPaths('/repo', 'en');
  assert.equal(p.outDir, path.join('/repo', '.local-wiki', 'en', 'content'));
  assert.equal(p.metaDir, path.join('/repo', '.local-wiki', 'en', 'meta'));
  assert.equal(p.catalogPath, path.join('/repo', '.local-wiki', 'en', 'meta', 'catalog.json'));
  const sr = wikiPaths('/repo', 'sr');
  assert.ok(sr.catalogPath.includes(path.join('.local-wiki', 'sr')));
});
```

```ts
import * as path from 'node:path';

export interface WikiPaths { outDir: string; metaDir: string; catalogPath: string }

export function wikiPaths(repoRoot: string, language: string): WikiPaths {
  const safeLang = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(language) ? language : 'en';
  const outDir = path.join(repoRoot, '.local-wiki', safeLang, 'content');
  return {
    outDir,
    metaDir: path.join(path.dirname(outDir), 'meta'),
    catalogPath: path.join(path.dirname(outDir), 'meta', 'catalog.json'),
  };
}
```

- [ ] **Step 3: `test/catalog.test.ts`** then **`src/pure/catalog.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCatalog, type CatalogPage } from '../src/pure/catalog.js';

function fixture(): { repo: string; page: CatalogPage } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-cat-'));
  const page: CatalogPage = {
    path: 'guides/testing.md', title: 'Testing', description: 'd',
    dependent_files: ['test/a.test.js'], parent: 'guides/guides.md',
    isLanding: false, quality: 'ok', protected: false,
  };
  const meta = path.join(repo, '.local-wiki', 'en', 'meta');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'catalog.json'), JSON.stringify({
    repo: 'r', model: 'm', language: 'en', generatedAt: 'now', pages: [page],
  }));
  return { repo, page };
}

test('readCatalog returns parsed catalog', () => {
  const { repo, page } = fixture();
  const catalog = readCatalog(repo, 'en');
  assert.ok(catalog);
  assert.deepEqual(catalog.pages[0], page);
});

test('readCatalog returns null when absent or malformed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-cat-'));
  assert.equal(readCatalog(repo, 'en'), null);
  const meta = path.join(repo, '.local-wiki', 'en', 'meta');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'catalog.json'), '{oops');
  assert.equal(readCatalog(repo, 'en'), null);
});
```

```ts
import * as fs from 'node:fs';
import { wikiPaths } from './paths.js';

export interface CatalogPage {
  path: string; title: string; description: string;
  dependent_files: string[]; parent: string | null;
  isLanding: boolean; quality: 'ok' | 'degraded'; protected: boolean;
}
export interface Catalog {
  repo: string; model: string; language: string; generatedAt: string; pages: CatalogPage[];
}

export function readCatalog(repoRoot: string, language: string): Catalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(wikiPaths(repoRoot, language).catalogPath, 'utf8'));
    if (!raw || !Array.isArray(raw.pages)) return null;
    const pages: CatalogPage[] = [];
    for (const p of raw.pages) {
      if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') continue;
      pages.push({
        path: p.path,
        title: p.title,
        description: String(p.description || ''),
        dependent_files: Array.isArray(p.dependent_files) ? p.dependent_files.filter((f: unknown): f is string => typeof f === 'string') : [],
        parent: typeof p.parent === 'string' ? p.parent : null,
        isLanding: p.isLanding === true,
        quality: p.quality === 'degraded' ? 'degraded' : 'ok',
        protected: p.protected === true,
      });
    }
    return {
      repo: String(raw.repo || ''),
      model: String(raw.model || ''),
      language: String(raw.language || language),
      generatedAt: String(raw.generatedAt || ''),
      pages,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: `test/treeModel.test.ts`** then **`src/pure/treeModel.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, pageUriPath } from '../src/pure/treeModel.js';
import type { CatalogPage } from '../src/pure/catalog.js';

const mk = (over: Partial<CatalogPage>): CatalogPage => ({
  path: 'x.md', title: 'X', description: '', dependent_files: [],
  parent: null, isLanding: false, quality: 'ok', protected: false, ...over,
});

test('buildTree nests children under parents and keeps catalog order', () => {
  const pages = [
    mk({ path: 'overview.md', title: 'Overview' }),
    mk({ path: 'guides/guides.md', title: 'Guides', isLanding: true }),
    mk({ path: 'guides/testing.md', title: 'Testing', parent: 'guides/guides.md' }),
    mk({ path: 'guides/deploy.md', title: 'Deploy', parent: 'guides/guides.md' }),
  ];
  const tree = buildTree({ repo: 'r', model: 'm', language: 'en', generatedAt: '', pages });
  assert.deepEqual(tree.map(n => n.page.path), ['overview.md', 'guides/guides.md']);
  const guides = tree[1];
  assert.deepEqual(guides.children.map(n => n.page.path), ['guides/testing.md', 'guides/deploy.md']);
});

test('orphans (unknown parent) surface at root instead of vanishing', () => {
  const pages = [mk({ path: 'a.md', parent: 'ghost.md' })];
  const tree = buildTree({ repo: 'r', model: 'm', language: 'en', generatedAt: '', pages });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].page.path, 'a.md');
});

test('pageUriPath produces repo-relative file paths', () => {
  assert.equal(pageUriPath('guides/testing.md'), '.local-wiki/en/content/guides/testing.md');
});
```

```ts
import type { Catalog, CatalogPage } from './catalog.js';
import { wikiPaths } from './paths.js';
import * as path from 'node:path';

export interface TreeNode { page: CatalogPage; children: TreeNode[] }

export function buildTree(catalog: Catalog): TreeNode[] {
  const byPath = new Map(catalog.pages.map(p => [p.path, p]));
  const nodes = new Map<string, TreeNode>(catalog.pages.map(p => [p.path, { page: p, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = node.page.parent;
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (parent && parent.path !== node.page.path) {
      nodes.get(parent.path)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function pageUriPath(pagePath: string, language = 'en'): string {
  const { outDir } = wikiPaths('', language);
  return path.join(outDir, pagePath);
}
```

NOTE for the test: `pageUriPath` with wikiPaths('', 'en') yields `.local-wiki/en/content/guides/testing.md` via path.join — on any platform path.join('', ...) returns the relative posix path; assert with path.join in the test to be platform-safe: change the assertion to `assert.equal(pageUriPath('guides/testing.md'), path.join('.local-wiki', 'en', 'content', 'guides/testing.md'))` (import path in the test).

- [ ] **Step 5: `test/progress.test.ts`** then **`src/pure/progress.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunProgress } from '../src/pure/progress.js';

test('maps the event stream to progress messages and increments', () => {
  const p = createRunProgress();
  assert.equal(p({ type: 'plan_ready', ts: 'x', pages: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] }), null);
  const done = p({ type: 'page_done', ts: 'x', path: 'a.md', status: 'generated' });
  assert.ok(done);
  assert.match(done!.message, /a\.md \(1\/2\)/);
  assert.ok(done!.increment > 0);
  const fail = p({ type: 'page_fail', ts: 'x', path: 'b.md', message: 'boom' });
  assert.ok(fail);
  assert.match(fail!.message, /b\.md/);
});

test('irrelevant events map to null; unknown totals degrade gracefully', () => {
  const p = createRunProgress();
  assert.equal(p({ type: 'scan_done', ts: 'x', files: 9 }), null);
  const done = p({ type: 'page_done', ts: 'x', path: 'a.md', status: 'cached' as never });
  assert.ok(done);
  assert.match(done!.message, /a\.md \(1\//);
});
```

```ts
import type { WikiEvent } from './events.js';

export interface ProgressUpdate { message: string; increment: number }

export function createRunProgress(): (event: WikiEvent) => ProgressUpdate | null {
  let total = 0;
  let done = 0;
  return (event) => {
    switch (event.type) {
      case 'plan_ready': {
        total = Array.isArray(event.pages) ? event.pages.length : 0;
        return null; // message set by the caller via plan summary if desired
      }
      case 'page_done': {
        done += 1;
        const where = total > 0 ? ` (${done}/${total})` : '';
        return { message: `${event.path}${where}`, increment: total > 0 ? 85 / total : 10 };
      }
      case 'page_fail': {
        done += 1;
        const where = total > 0 ? ` (${done}/${total})` : '';
        return { message: `failed: ${event.path}${where}`, increment: total > 0 ? 85 / total : 10 };
      }
      case 'knowledge_started':
        return { message: 'generating knowledge cards', increment: 2 };
      default:
        return null;
    }
  };
}
```

- [ ] **Step 6: `test/args.test.ts`** then **`src/pure/args.ts`**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildGenerateArgs, buildModifyArgs, buildListModelsArgs } from '../src/pure/args.js';

test('generate args: json-events + language-derived out dir + optional flags', () => {
  assert.deepEqual(buildGenerateArgs({ repoRoot: '/repo', language: 'en' }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'en', 'content'),
  ]);
  assert.deepEqual(buildGenerateArgs({ repoRoot: '/repo', language: 'en', model: 'kimi', configPath: '/c.json', force: true, knowledge: true }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'en', 'content'),
    '-m', 'kimi', '--config', '/c.json', '--force', '--knowledge',
  ]);
});

test('modify args: page + op + instruction', () => {
  assert.deepEqual(buildModifyArgs({ repoRoot: '/repo', language: 'sr', pagePath: 'a.md', operation: 'supplement', instruction: 'add X', model: 'm', configPath: '/c.json' }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'sr', 'content'),
    '-m', 'm', '--config', '/c.json',
    '--modify', 'a.md', '--op', 'supplement', '--instruction', 'add X',
  ]);
});

test('list-models args', () => {
  assert.deepEqual(buildListModelsArgs({ repoRoot: '/r', configPath: '/c.json' }), ['/r', '--list-models', '--json-events', '--config', '/c.json']);
  assert.deepEqual(buildListModelsArgs({ repoRoot: '/r' }), ['/r', '--list-models', '--json-events']);
});
```

```ts
import * as path from 'node:path';
import { wikiPaths } from './paths.js';

export interface EngineTarget { repoRoot: string; language: string; model?: string; configPath?: string }

function baseArgs(t: EngineTarget): string[] {
  const args = [t.repoRoot, '--json-events', '-o', wikiPaths(t.repoRoot, t.language).outDir];
  if (t.model) args.push('-m', t.model);
  if (t.configPath) args.push('--config', t.configPath);
  return args;
}

export interface GenerateOptions extends EngineTarget { force?: boolean; knowledge?: boolean }

export function buildGenerateArgs(o: GenerateOptions): string[] {
  const args = baseArgs(o);
  if (o.force) args.push('--force');
  if (o.knowledge) args.push('--knowledge');
  return args;
}

export interface ModifyOptions extends EngineTarget { pagePath: string; operation: 'modify' | 'supplement' | 'rewrite'; instruction: string }

export function buildModifyArgs(o: ModifyOptions): string[] {
  return [...baseArgs(o), '--modify', o.pagePath, '--op', o.operation, '--instruction', o.instruction];
}

export function buildListModelsArgs(o: { repoRoot: string; configPath?: string }): string[] {
  const args = [o.repoRoot, '--list-models', '--json-events'];
  if (o.configPath) args.push('--config', o.configPath);
  return args;
}
```

- [ ] **Step 7: `src/pure/planScaffold.ts`** (no test needed — constant; verified by Task 6):

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WIKI_PLAN_TEMPLATE = `version: 1

repowiki:
  template: ""           # "architecture" | "product_requirement" | ""
  notes:                 # guidance injected into planning prompts
    # - text: "Focus on business workflows rather than code details"
    #   author: "your-name"
  documents:             # strict page allowlist (one parent level only)
    # - title: "System Architecture Overview"
    #   goal: "Describe modules and interactions"
    # - title: "Order System"
    #   goal: "Explain the order lifecycle"
    #   parent: "System Architecture Overview"
    #   hints: "Include the payment flow"

knowledgecard:
  notes: []
    # - text: "Focus on the payment and order modules"

scope:
  include: []            # gitignore-style globs, e.g. "src/**"
  exclude: []            # e.g. "**/test/**"
`;

export function scaffoldPlan(repoRoot: string): string {
  const file = path.join(repoRoot, 'wiki_plan.yaml');
  if (!fs.existsSync(file)) fs.writeFileSync(file, WIKI_PLAN_TEMPLATE);
  return file;
}
```

- [ ] **Step 8: Run `npm test` in extension/** — expect 6 test files, all green; `npm run typecheck` clean.
- [ ] **Step 9: Commit:** `git add extension && git commit -m "feat: pure core for events, catalog, tree, progress, and engine args"`

---

### Task 3: Engine runner (spawn + NDJSON + cancel) + generate command

**Files:** `src/enginePaths.ts`, `src/engineRunner.ts`, `src/extension.ts` (generate + showOutput wiring), `test/runner.e2e.test.ts`.

- [ ] **Step 1: `src/enginePaths.ts`** (complete):

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnginePaths { generateJs: string; exportJs: string; source: 'setting' | 'monorepo' | 'bundled' }

export function resolveEnginePaths(extensionPath: string, enginePathSetting?: string): EnginePaths {
  if (enginePathSetting) {
    const generateJs = path.join(enginePathSetting, 'generate.js');
    if (fs.existsSync(generateJs)) {
      return { generateJs, exportJs: path.join(enginePathSetting, 'export.js'), source: 'setting' };
    }
  }
  const monorepo = path.resolve(extensionPath, '..');
  if (fs.existsSync(path.join(monorepo, 'generate.js'))) {
    return { generateJs: path.join(monorepo, 'generate.js'), exportJs: path.join(monorepo, 'export.js'), source: 'monorepo' };
  }
  return {
    generateJs: path.join(extensionPath, 'dist', 'engine', 'generate.cjs'),
    exportJs: path.join(extensionPath, 'dist', 'engine', 'export.cjs'),
    source: 'bundled',
  };
}

export function resolveNodeCommand(nodePathSetting?: string): { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv } {
  if (nodePathSetting) return { command: nodePathSetting, prefixArgs: [], env: {} };
  if (process.platform !== 'win32' && process.execPath && !process.execPath.includes('electron', 40)) {
    // Real node (tests, CLI usage) — prefer it; guard against Electron via name check.
    if (require('node:path').basename(process.execPath).startsWith('node')) {
      return { command: process.execPath, prefixArgs: [], env: {} };
    }
  }
  // VSCode extension host: Electron binary forced into Node mode.
  return { command: process.execPath, prefixArgs: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
```

Simplify per review taste if needed, but keep the ORDER: setting → PATH `node` (spawn tries `node` first via command:'node') → ELECTRON_RUN_AS_NODE. Final semantics to implement: candidates list `[{command: nodePathSetting}, {command: 'node'}, {command: process.execPath, env ELECTRON_RUN_AS_NODE}]`, pick the first that exists/`-v`-probes OK (probe with spawnSync `-v`, 1500ms). Document chosen behavior in the file header comment.

- [ ] **Step 2: `src/engineRunner.ts`** (complete):

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { parseNdjsonLine, type WikiEvent } from './pure/events.js';

export interface RunResult { code: number; errorEvent?: { code?: string; message?: string } }
export interface RunOptions {
  args: string[];
  cwd: string;
  onEvent: (event: WikiEvent) => void;
  onLog?: (line: string) => void;
}

export class EngineRunner {
  private child: ChildProcess | null = null;
  private active: Promise<RunResult> | null = null;

  public isActive(): boolean { return this.active !== null; }

  public async run(command: string, scriptPath: string, prefixArgs: string[], env: NodeJS.ProcessEnv, opts: RunOptions): Promise<RunResult> {
    if (this.active) throw new Error('an engine run is already active');
    this.active = this.spawnRun(command, scriptPath, prefixArgs, env, opts);
    try {
      return await this.active;
    } finally {
      this.active = null;
    }
  }

  public cancel(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      const child = this.child;
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  }

  private spawnRun(command: string, scriptPath: string, prefixArgs: string[], env: NodeJS.ProcessEnv, opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...prefixArgs, scriptPath, ...opts.args], {
        cwd: opts.cwd,
        env: { ...process.env, ...env },
      });
      this.child = child;
      let buffer = '';
      let errorEvent: { code?: string; message?: string } | undefined;
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const event = parseNdjsonLine(line);
          if (event) {
            if (event.type === 'run_error') errorEvent = { code: event.code, message: event.message };
            opts.onEvent(event);
          } else {
            opts.onLog?.(line);
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => opts.onLog?.(chunk.toString('utf8').trimEnd()));
      child.on('error', (err) => {
        this.child = null;
        resolve({ code: -1, errorEvent: { code: 'spawn_failed', message: err.message } });
      });
      child.on('close', (code) => {
        this.child = null;
        resolve({ code: code ?? -1, errorEvent });
      });
    });
  }
}
```

- [ ] **Step 3: `test/runner.e2e.test.ts`** — real spawn against the BUNDLED engine, `--list-models` (no LLM needed):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineRunner } from '../src/engineRunner.js';
import type { WikiEvent } from '../src/pure/events.js';

const extensionRoot = path.resolve(__dirname, '..');
const bundledGenerate = path.join(extensionRoot, 'dist', 'engine', 'generate.cjs');

test('runner spawns the bundled engine and streams model_profile events', { skip: !fs.existsSync(bundledGenerate) ? 'run npm run compile first' : false }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-run-'));
  const configPath = path.join(repo, 'repo-wiki.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    default: 'mock', language: 'en',
    models: { mock: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-1' } },
  }));
  const events: WikiEvent[] = [];
  const logs: string[] = [];
  const runner = new EngineRunner();
  const result = await runner.run(process.execPath, bundledGenerate, [], {
    args: [repo, '--list-models', '--json-events', '--config', configPath],
    cwd: repo,
    onEvent: e => events.push(e),
    onLog: l => logs.push(l),
  });
  assert.equal(result.code, 0, logs.join('\n'));
  assert.ok(events.some(e => e.type === 'model_profile'), 'expected model_profile events');
  for (const e of events) assert.ok(typeof e.ts === 'string' && e.ts.length > 0);
});

test('runner reports spawn failures without throwing', async () => {
  const runner = new EngineRunner();
  const result = await runner.run('/nonexistent-node-binary-xyz', bundledOrSkip(), [], {
    args: ['--list-models'], cwd: process.cwd(), onEvent: () => {},
  });
  assert.equal(result.code, -1);
  assert.equal(result.errorEvent?.code, 'spawn_failed');
});

function bundledOrSkip(): string {
  if (!fs.existsSync(bundledGenerate)) test.skip('run npm run compile first');
  return bundledGenerate;
}
```

- [ ] **Step 4: wire generate + showOutput in `src/extension.ts`** (replaces stub; tree/preview commands referenced but registered in later tasks — register ONLY what exists; this task registers generate + showOutput):

```ts
import * as vscode from 'vscode';
import { EngineRunner } from './engineRunner';
import { resolveEnginePaths, resolveNodeCommand } from './enginePaths';
import { buildGenerateArgs } from './pure/args';
import { createRunProgress } from './pure/progress';

const outputChannel = vscode.window.createOutputChannel('Repo Wiki Engine');
const runner = new EngineRunner();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.showOutput', () => outputChannel.show()));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.generate', async () => {
    const repoRoot = workspaceRoot();
    if (!repoRoot) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return; }
    if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return; }
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
    const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
    const args = buildGenerateArgs({
      repoRoot,
      language: config.get<string>('language') || 'en',
      model: config.get<string>('defaultModel') || undefined,
      configPath: config.get<string>('configPath') || undefined,
    });
    const progressOf = createRunProgress();
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Repo Wiki: generating',
      cancellable: true,
    }, async (progress, token) => {
      token.onCancellationRequested(() => runner.cancel());
      progress.report({ message: 'starting engine…', increment: 0 });
      const result = await runner.run(node.command, engine.generateJs, node.prefixArgs, node.env, {
        args,
        cwd: repoRoot,
        onEvent: event => {
          const update = progressOf(event);
          if (update) progress.report(update);
          outputChannel.appendLine(JSON.stringify(event));
        },
        onLog: line => outputChannel.appendLine(line),
      });
      if (result.code !== 0) {
        void vscode.window.showErrorMessage(
          `Repo Wiki: run failed${result.errorEvent?.code ? ` (${result.errorEvent.code})` : ''}: ${result.errorEvent?.message ?? 'see output'}`,
          'Show output',
        ).then(choice => { if (choice === 'Show output') outputChannel.show(); });
      } else {
        void vscode.window.showInformationMessage('Repo Wiki: generation finished.');
      }
    });
  }));
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function deactivate(): void {
  runner.cancel();
}
```

- [ ] **Step 5: `npm run compile && npm run typecheck && npm test`** in extension/ — runner e2e runs against the fresh bundle; all green.
- [ ] **Step 6: Commit:** `git add extension && git commit -m "feat: engine runner with NDJSON streaming, cancellation, and generate command"`

---

### Task 4: Tree view (catalog → wiki tree)

**Files:** `src/wikiTree.ts`, `src/extension.ts` (register tree + refresh + click → open raw md).

- [ ] **Step 1: `src/wikiTree.ts`** (complete):

```ts
import * as vscode from 'vscode';
import { readCatalog, type Catalog } from './pure/catalog';
import { buildTree, pageUriPath, type TreeNode } from './pure/treeModel';

export class WikiTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this.event;
  private catalog: Catalog | null = null;

  constructor(private readonly getRoot: () => string | undefined, private readonly getLanguage: () => string) {}

  private get event(): vscode.Event<TreeNode | undefined | void> { return this.emitter.event; }

  public refresh(): void {
    const root = this.getRoot();
    this.catalog = root ? readCatalog(root, this.getLanguage()) : null;
    this.emitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.page.title,
      element.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.tooltip = new vscode.MarkdownString(
      `${element.page.path}${element.page.protected ? ' 🔒 (protected)' : ''}${element.page.quality === 'degraded' ? ' ⚠ degraded' : ''}`,
    );
    item.description = element.page.protected ? '🔒' : element.page.quality === 'degraded' ? '⚠' : '';
    item.iconPath = element.page.isLanding ? new vscode.ThemeIcon('layout-sidebar-left') : new vscode.ThemeIcon('book');
    item.contextValue = 'page';
    item.command = {
      command: 'openRepoWiki.openPage',
      title: 'Open Page',
      arguments: [element],
    };
    return item;
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!this.catalog) return [];
    if (!element) return buildTree(this.catalog);
    return element.children;
  }

  public pageFilePath(node: TreeNode): string {
    return pageUriPath(node.page.path, this.getLanguage());
  }
}
```

- [ ] **Step 2: register in `extension.ts`** (add to activate):

```ts
const tree = new WikiTree(workspaceRoot, () => vscode.workspace.getConfiguration('openRepoWiki').get<string>('language') || 'en');
context.subscriptions.push(
  vscode.window.registerTreeDataProvider('openRepoWiki.pages', tree),
  vscode.commands.registerCommand('openRepoWiki.refreshTree', () => tree.refresh()),
  vscode.commands.registerCommand('openRepoWiki.openPage', async (node: TreeNode) => {
    const root = workspaceRoot();
    if (!root) return;
    const file = vscode.Uri.file(`${root}/${tree.pageFilePath(node)}`);
    try {
      await vscode.window.showTextDocument(file);
    } catch {
      void vscode.window.showErrorMessage(`Repo Wiki: page file missing: ${node.page.path}`);
    }
  }),
);
tree.refresh();
// after a successful generate run: tree.refresh() (add to the generate command's success branch)
```

- [ ] **Step 3: `npm run compile && npm run typecheck && npm test`** — green. Manual check optional (F5: tree shows welcome view in an empty workspace; with a generated repo, pages listed).
- [ ] **Step 4: Commit:** `git add extension && git commit -m "feat: wiki pages tree view with protected badges"`

---

### Task 5: Webview preview panel

**Files:** `webview/page.html`, `webview/page.css`, `webview/webview.js` (real content), `src/preview.ts`, `src/extension.ts` (openPage → preview, Edit source message).

- [ ] **Step 1: `webview/page.html`** (complete):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https: data:;">
  <link rel="stylesheet" href="${highlightCssUri}">
  <link rel="stylesheet" href="${pageCssUri}">
</head>
<body>
  <header id="topbar">
    <span id="title"></span>
    <span id="badges"></span>
    <button id="edit-source" type="button">Edit source</button>
  </header>
  <main id="page"></main>
  <script src="${markedUri}"></script>
  <script src="${highlightUri}"></script>
  <script src="${mermaidUri}"></script>
  <script src="${webviewJsUri}"></script>
</body>
</html>
```

- [ ] **Step 2: `webview/page.css`** (complete, GitHub-like):

```css
:root { color-scheme: light dark; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
#topbar { display: flex; gap: 8px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border, #ddd); position: sticky; top: 0; background: var(--vscode-sideBar-background, #fff); }
#title { font-weight: 600; }
#badges .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background, #666); color: var(--vscode-badge-foreground, #fff); margin-right: 4px; }
#edit-source { margin-left: auto; cursor: pointer; }
main { max-width: 860px; margin: 0 auto; padding: 24px 32px 64px; line-height: 1.6; }
main h1 { border-bottom: 1px solid var(--vscode-panel-border, #ddd); padding-bottom: 8px; }
main h2 { border-bottom: 1px solid var(--vscode-panel-border, #eee); padding-bottom: 4px; margin-top: 32px; }
main pre { background: var(--vscode-textCodeBlock-background, #f6f8fa); padding: 12px; border-radius: 6px; overflow: auto; }
main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
main table { border-collapse: collapse; } main th, main td { border: 1px solid var(--vscode-panel-border, #ddd); padding: 6px 12px; }
main blockquote { border-left: 4px solid var(--vscode-panel-border, #ddd); margin-left: 0; padding-left: 12px; color: var(--vscode-descriptionForeground, #666); }
main a { color: var(--vscode-textLink-foreground, #0969da); }
main img { max-width: 100%; }
```

- [ ] **Step 3: `webview/webview.js`** (complete — render + protocol):

```js
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  marked.setOptions({ gfm: true, breaks: false });
  let state = { currentPath: null };

  function post(message) { vscode.postMessage(message); }

  function renderPage(page) {
    state.currentPath = page.path;
    document.getElementById('title').textContent = page.title;
    const badges = document.getElementById('badges');
    badges.innerHTML = '';
    if (page.protected) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '🔒 protected';
      badges.appendChild(badge);
    }
    if (page.quality === 'degraded') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '⚠ degraded';
      badges.appendChild(badge);
    }
    const main = document.getElementById('page');
    main.innerHTML = marked.parse(page.markdown);
    main.querySelectorAll('pre code').forEach(block => { try { hljs.highlightElement(block); } catch { /* non-code */ } });
    // Links: internal .md links navigate in-panel; the rest open externally.
    main.querySelectorAll('a[href]').forEach(anchor => {
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        const href = anchor.getAttribute('href') || '';
        if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#')) {
          if (href.startsWith('#')) return; // in-page anchors: default behavior
          post({ command: 'openExternal', href });
        } else {
          post({ command: 'navigate', href });
        }
      });
    });
    // Render mermaid after the DOM is populated.
    if (window.mermaid) {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.body.classList.contains('vscode-dark') ? 'dark' : 'default' });
      window.mermaid.run({ nodes: main.querySelectorAll('pre code.language-mermaid') }).catch(() => { /* leave fenced */ });
    }
    vscode.setState(state);
  }

  document.getElementById('edit-source').addEventListener('click', () => post({ command: 'editSource', path: state.currentPath }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.command === 'show' && message.page) renderPage(message.page);
  });
}());
```

- [ ] **Step 4: `src/preview.ts`** (complete):

```ts
import * as vscode from 'vscode';
import * as path from 'node:path';

export interface PreviewPage { path: string; title: string; markdown: string; protected: boolean; quality: 'ok' | 'degraded' }

export class WikiPreview {
  private panel: vscode.WebviewPanel | null = null;
  private readonly html: string;

  constructor(private readonly extensionPath: string, private readonly getLanguage: () => string) {
    this.html = ''; // built lazily per panel (needs webview.cspSource)
  }

  public show(page: PreviewPage, onNavigate: (href: string) => void, onEditSource: (pagePath: string) => void): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('openRepoWiki.preview', 'Repo Wiki Preview', vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, 'dist', 'webview'))],
      });
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.command === 'navigate' && typeof message.href === 'string') onNavigate(message.href);
        if (message.command === 'editSource' && typeof message.path === 'string') onEditSource(message.path);
        if (message.command === 'openExternal' && typeof message.href === 'string') {
          void vscode.env.openExternal(vscode.Uri.parse(message.href));
        }
      });
      this.panel.onDidDispose(() => { this.panel = null; });
    } else {
      this.panel.reveal();
    }
    void this.panel.webview.postMessage({ command: 'show', page });
  }

  private buildHtml(webview: vscode.Webview): string {
    const dir = (file: string) => webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'dist', 'webview', file)));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:;">
  <link rel="stylesheet" href="${dir('highlight.css')}">
  <link rel="stylesheet" href="${dir('page.css')}">
</head>
<body>
  <header id="topbar"><span id="title"></span><span id="badges"></span><button id="edit-source" type="button">Edit source</button></header>
  <main id="page"></main>
  <script src="${dir('marked.js')}"></script>
  <script src="${dir('highlight.js')}"></script>
  <script src="${dir('mermaid.js')}"></script>
  <script src="${dir('webview.js')}"></script>
</body>
</html>`;
  }
}
```

Note: `webview/page.html` in the source folder documents the same markup; `buildHtml` is authoritative (needs webview.cspSource). Keep both in sync or drop the source html file and note it — DROP the source page.html in this task (delete from webview/ and build.mjs's copy list) to avoid drift; page.css + webview.js remain sourced from webview/ and copied.

- [ ] **Step 5: wire openPage → preview in `extension.ts`** (replace raw-open from Task 4): openPage resolves the node → reads the page file (`fs.promises.readFile`) → `preview.show({path,title,markdown,protected,quality}, navigate, editSource)` where navigate resolves relative `.md` hrefs against the current page's directory to a catalog page path (use catalog lookup via a helper `resolveHref(catalog, currentPath, href)` in `pure/treeModel.ts` — implement: normalize, join dirs, strip leading './', find in catalog by exact path or by basename match) → preview.show for that node's page; editSource opens the raw md in the editor.

Add `resolveHref` to `pure/treeModel.ts` + a test (`test/treeModel.test.ts` add):

```ts
test('resolveHref resolves relative markdown links against the current page', () => {
  const pages = [
    mk({ path: 'overview.md', title: 'O' }),
    mk({ path: 'guides/guides.md', title: 'G', isLanding: true }),
    mk({ path: 'guides/testing.md', title: 'T', parent: 'guides/guides.md' }),
  ];
  const catalog = { repo: 'r', model: 'm', language: 'en', generatedAt: '', pages };
  assert.equal(resolveHref(catalog, 'guides/testing.md', 'guides.md'), 'guides/guides.md');
  assert.equal(resolveHref(catalog, 'guides/testing.md', '../overview.md'), 'overview.md');
  assert.equal(resolveHref(catalog, 'overview.md', 'guides/testing.md'), 'guides/testing.md');
  assert.equal(resolveHref(catalog, 'overview.md', 'https://x.dev/a.md'), null);
});
```

Implementation:

```ts
export function resolveHref(catalog: Catalog, currentPagePath: string, href: string): string | null {
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return null;
  const clean = href.split('#')[0].trim();
  if (!clean || !clean.toLowerCase().endsWith('.md')) return null;
  const baseDir = currentPagePath.includes('/') ? currentPagePath.slice(0, currentPagePath.lastIndexOf('/')) : '';
  const joined = clean.startsWith('/') ? clean.slice(1) : (baseDir ? `${baseDir}/${clean}` : clean);
  const normalized: string[] = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { normalized.pop(); continue; }
    normalized.push(segment);
  }
  const target = normalized.join('/');
  if (catalog.pages.some(p => p.path === target)) return target;
  const byBasename = catalog.pages.find(p => p.path.endsWith(`/${target}`) || p.path === target);
  return byBasename ? byBasename.path : null;
}
```

- [ ] **Step 6: `npm run compile && npm run typecheck && npm test`** — green (treeModel tests extended).
- [ ] **Step 7: Commit:** `git add extension && git commit -m "feat: webview preview with mermaid, protected badges, and in-panel navigation"`

---

### Task 6: Commands — modifyPage, editPlan, selectModel, selectLanguage, exportPdf

**Files:** `src/extension.ts` additions; uses pure/args + planScaffold; `src/enginePaths.ts` (exportJs).

- [ ] **Step 1: modifyPage command** (in extension.ts):

```ts
context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.modifyPage', async (node?: TreeNode) => {
  const root = workspaceRoot();
  if (!root) return;
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const language = config.get<string>('language') || 'en';
  const catalog = readCatalog(root, language);
  if (!catalog) { void vscode.window.showWarningMessage('Repo Wiki: generate a wiki first.'); return; }
  let pagePath = node?.page.path;
  if (!pagePath) {
    const picked = await vscode.window.showQuickPick(
      catalog.pages.map(p => ({ label: p.title, description: p.path, detail: p.protected ? '🔒 protected' : undefined, path: p.path })),
      { placeHolder: 'Which page?' },
    );
    if (!picked) return;
    pagePath = picked.path;
  }
  const operation = await vscode.window.showQuickPick(
    [
      { label: 'Modify', description: 'targeted edits, keep structure', value: 'modify' as const },
      { label: 'Supplement', description: 'append new content only', value: 'supplement' as const },
      { label: 'Rewrite', description: 'full rewrite', value: 'rewrite' as const },
    ],
    { placeHolder: `Operation on ${pagePath}` },
  );
  if (!operation) return;
  const instruction = await vscode.window.showInputBox({
    prompt: `Instruction for ${operation.value} of ${pagePath}`,
    ignoreFocusOut: true,
  });
  if (!instruction) return;
  // spawn engine with buildModifyArgs via the shared runner + progress (mirror generate, title 'Repo Wiki: modifying')
  // then tree.refresh() and preview refresh if visible.
}));
```

Implement the run by extracting a shared `runEngineWithProgress(title, args, cwd, context)` helper in extension.ts used by both generate and modify (avoid duplication).

- [ ] **Step 2: editPlan command**:

```ts
context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.editPlan', async () => {
  const root = workspaceRoot();
  if (!root) return;
  const file = scaffoldPlan(root);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  void vscode.window.showInformationMessage('Repo Wiki: after editing wiki_plan.yaml, run Generate to apply.');
}));
```

- [ ] **Step 3: selectModel command** — run engine `--list-models --json-events`, collect `model_profile` events, quick pick, set global setting:

```ts
context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.selectModel', async () => {
  const root = workspaceRoot();
  if (!root) return;
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
  const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
  const profiles: Array<{ name: string; provider: string; model: string; isDefault: boolean }> = [];
  const result = await runner.run(node.command, engine.generateJs, node.prefixArgs, node.env, {
    args: buildListModelsArgs({ repoRoot: root, configPath: config.get<string>('configPath') || undefined }),
    cwd: root,
    onEvent: event => {
      if (event.type === 'model_profile' && event.name) {
        profiles.push({ name: event.name, provider: event.provider || '', model: event.model || '', isDefault: event.default === true });
      }
    },
  });
  if (!profiles.length) { void vscode.window.showErrorMessage(`Repo Wiki: no model profiles (${result.errorEvent?.message ?? 'check config'})`); return; }
  const picked = await vscode.window.showQuickPick(
    profiles.map(p => ({ label: p.name, description: `${p.provider}: ${p.model}`, detail: p.isDefault ? 'config default' : undefined, name: p.name })),
    { placeHolder: 'Default model profile' },
  );
  if (picked) await config.update('defaultModel', picked.name, vscode.ConfigurationTarget.Global);
}));
```

- [ ] **Step 4: selectLanguage command** (quick pick of free-text languages with common presets):

```ts
context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.selectLanguage', async () => {
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const picked = await vscode.window.showQuickPick(
    ['en', 'sr', 'zh', 'de', 'fr', 'es'].map(l => ({ label: l })),
    { placeHolder: 'Wiki language (creates .local-wiki/<lang>)' },
  );
  if (picked) {
    await config.update('language', picked.label, vscode.ConfigurationTarget.Workspace);
    tree.refresh();
  }
}));
```

- [ ] **Step 5: exportPdf command** — capability check then run export.cjs:

```ts
context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.exportPdf', async () => {
  const root = workspaceRoot();
  if (!root) return;
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
  const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
  const language = config.get<string>('language') || 'en';
  const outDir = wikiPaths(root, language).outDir;
  if (!fs.existsSync(outDir)) { void vscode.window.showWarningMessage('Repo Wiki: generate a wiki first.'); return; }
  // PDF export needs playwright + pdf-lib resolvable next to the engine script.
  const engineDir = path.dirname(engine.exportJs);
  const hasPdfDeps = ['playwright', 'pdf-lib'].every(dep =>
    fs.existsSync(path.join(engineDir, 'node_modules', dep)) || fs.existsSync(path.join(engineDir, '..', 'node_modules', dep)),
  );
  if (!hasPdfDeps) {
    const choice = await vscode.window.showWarningMessage(
      'PDF export needs the engine\'s optional packages (playwright, pdf-lib).',
      'How to install',
    );
    if (choice === 'How to install') {
      void vscode.env.openExternal(vscode.Uri.parse('https://github.com/genes8/open-repo-wiki#install'));
    }
    return;
  }
  const pdfDir = path.join(root, 'wiki-pdf');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Repo Wiki: exporting PDF', cancellable: false }, async () => {
    const result = await runner.run(node.command, engine.exportJs, node.prefixArgs, node.env, {
      args: [outDir, pdfDir],
      cwd: root,
      onEvent: () => {},
      onLog: line => outputChannel.appendLine(line),
    });
    if (result.code === 0) {
      void vscode.window.showInformationMessage('Repo Wiki: PDF export finished.', 'Reveal folder').then(c => {
        if (c === 'Reveal folder') void vscode.env.openExternal(vscode.Uri.file(pdfDir));
      });
    } else {
      void vscode.window.showErrorMessage('Repo Wiki: PDF export failed — see output.');
    }
  });
}));
```

NOTE: runner.run is single-flight with generate; exportPdf must check `runner.isActive()` first (same pattern as generate).

- [ ] **Step 6: `npm run compile && npm run typecheck && npm test`** — green.
- [ ] **Step 7: Commit:** `git add extension && git commit -m "feat: modify, plan editing, model/language selection, and pdf export commands"`

---

### Task 7: Change detection + status bar + autoUpdate

**Files:** `src/statusBar.ts`, `src/changeDetector.ts`, `src/extension.ts` wiring.

- [ ] **Step 1: `src/statusBar.ts`**:

```ts
import * as vscode from 'vscode';

export class UpdateStatusBar {
  private item: vscode.StatusBarItem;

  constructor(private readonly onGenerate: () => void) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.text = '$(book) Repo Wiki: update available';
    this.item.tooltip = 'Source files referenced by the wiki changed — regenerate?';
    this.item.command = 'openRepoWiki.generate';
    this.item.hide();
  }

  public show(): void { this.item.show(); }
  public hide(): void { this.item.hide(); }
  public dispose(): void { this.item.dispose(); }
}
```

- [ ] **Step 2: `src/changeDetector.ts`**:

```ts
import * as vscode from 'vscode';
import * as path from 'node:path';
import { readCatalog } from './pure/catalog';

const DEBOUNCE_MS = 2000;

export class ChangeDetector implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly disposable: vscode.Disposable;

  constructor(
    private readonly getRoot: () => string | undefined,
    private readonly getLanguage: () => string,
    private readonly onChanged: (autoRun: boolean) => void,
  ) {
    this.disposable = vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc));
  }

  private onSave(doc: vscode.TextDocument): void {
    const root = this.getRoot();
    if (!root || doc.uri.scheme !== 'file') return;
    const rel = path.relative(root, doc.uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    // Wiki markdown edits are the protection path (engine handles them); only
    // SOURCE files trigger update hints.
    if (rel.split(path.sep).includes('.local-wiki')) return;
    const catalog = readCatalog(root, this.getLanguage());
    if (!catalog) return;
    const relPosix = rel.split(path.sep).join('/');
    const belongs = catalog.pages.some(page => page.dependent_files.includes(relPosix));
    if (!belongs) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const auto = vscode.workspace.getConfiguration('openRepoWiki').get<string>('autoUpdate') || 'notify';
      if (auto !== 'off') this.onChanged(auto === 'auto');
    }, DEBOUNCE_MS);
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.disposable.dispose();
  }
}
```

- [ ] **Step 3: wire in `extension.ts`:** statusBar created + changeDetector with callback: `(autoRun) => { if (autoRun) void vscode.commands.executeCommand('openRepoWiki.generate'); else status.show(); }`; hide the status item when a generate run starts (in the shared run helper). Also `tree.refresh()` + `status.hide()` after every successful generate/modify run.
- [ ] **Step 4: `npm run compile && npm run typecheck && npm test`** — green.
- [ ] **Step 5: Commit:** `git add extension && git commit -m "feat: save-triggered update detection with status bar and auto-update mode"`

---

### Task 8: Packaging, docs, smoke checklist

**Files:** `extension/README.md`, `extension/TESTING.md`, root `README.md` (section), `.vscodeignore` final check, package version note.

- [ ] **Step 1: `extension/README.md`** — short: what it does (5 bullets), install from `.vsix` (F1 → Extensions: Install from VSIX), settings table (6 settings), commands table (9 commands), engine resolution order (setting → monorepo → bundled), PDF deps note, screenshot placeholder for marketplace later.
- [ ] **Step 2: `extension/TESTING.md`** — F5 smoke checklist (10 items): extension host launches; empty workspace shows welcome + Generate; generate against a small repo with mock/real config shows progress + tree fills; page click opens preview with mermaid + code highlight; 🔒 on manually edited page after regen; modifyPage supplement flow; editPlan scaffold; selectModel quick pick; exportPdf behavior without deps (guidance message); save a dependent file → status bar hint.
- [ ] **Step 3: Root `README.md`** — add "VSCode extension" section after CLI: `cd extension && npm install && npm run package` → `open-repo-wiki-0.1.0.vsix` → install from VSIX; link extension/README.md.
- [ ] **Step 4: verify packaging:** `cd extension && npm run package` — vsce produces `open-repo-wiki-0.1.0.vix`… verify the exact filename `open-repo-wiki-0.1.0.vsix`; `vsce ls` lists only dist/, media/, README, LICENSE, package.json (no src/node_modules). If vsce complains about missing repository/icon fields, add `"repository": {"type":"git","url":"https://github.com/genes8/open-repo-wiki.git"}` to package.json (it belongs there anyway).
- [ ] **Step 5: install + smoke locally (documented, user-run):** note in TESTING.md; agent verifies compile+tests+package only.
- [ ] **Step 6: `npm test && npm run typecheck` final; commit:** `git add extension README.md && git commit -m "docs: extension readme, smoke checklist, and vsce packaging"`

---

## Self-review (checked at planning time)

- Spec coverage: tree+icons+welcome (T4), preview+mermaid+edit-source+protected badge (T5), generate/modify/editPlan/exportPdf/selectModel/showOutput commands (T3/T6), change detection + autoUpdate notify|auto|off (T7), settings incl. enginePath/nodePath (T3/T6), child process + SIGTERM cancel + single-flight (T3), packaging A-ready B-possible (T1/T8), TESTING.md (T8).
- Known accepted risks (documented for executors): SIGTERM leaves engine stage dirs (engine-side follow-up, not extension); exportPdf requires engine node_modules with playwright/pdf-lib (guidance message implemented); bundled engine without optional natives → llamacpp provider error message at runtime (by design).
- Type consistency: WikiEvent union ↔ lib/events.js vocabulary (27); CatalogPage ↔ catalog.json fields; args builders ↔ CLI flags from Plan A; TreeNode used by tree + preview navigation.
- The plan intentionally deletes `webview/page.html` in Task 5 (buildHtml is authoritative) — update build.mjs copy list accordingly (remove 'page.html').
