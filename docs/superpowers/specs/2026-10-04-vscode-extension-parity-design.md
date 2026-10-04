# VSCode Extension + Qoder Parity — Design

Date: 2026-10-04
Status: approved (brainstorming session 2026-10-04)

## Goal

Bring open-repo-wiki to full Qoder Repo Wiki parity inside VSCode: generate,
update, modify, and protect a repository wiki from a single extension, using any
configured LLM backend (OpenAI-compatible, Ollama, in-process GGUF). The engine
stays a zero-dependency CLI usable without VSCode.

## Context

The engine already covers: multi-provider profiles, plan→generate pipeline with
deterministic validation and source-coverage guarantee, transactional writes,
incremental regeneration (input-hash cache), citations, TOC, landing pages,
`catalog.json` + index, optional knowledge layer, multilingual output, PDF
export, dry-run/prune.

Missing vs Qoder (from docs.qoder.com/user-guide/repo-wiki and artifacts in
`.qoder/repowiki/` of this repo):

1. `wiki_plan.yaml` pre-generation configuration
2. Modify / Supplement / Rewrite operations
3. Manual-edit protection
4. Update vs Sync distinction
5. An IDE-style interface at all

## Decisions (from brainstorming)

- **Interface: VSCode extension** (closest to Qoder's IDE UX; local-first).
  A web app is a possible later phase reusing the same `lib/api.js`.
- **Architecture: programmatic API + child process with structured events.**
  The extension never imports the engine in-process: the `llamacpp` provider
  needs native modules built for plain Node (extension host is Electron with a
  different ABI), and engine crashes must not take down the editor. The
  extension bundles the engine JS and runs it with system Node.
- **Distribution: local `.vsix` first** (install from file). Marketplace
  publishing later requires only a publisher account, icon, and CI — no code
  changes. `vsce package` must work from day one.
- **Manual-edit protection via dual hashes, no in-file markers.** State stores
  an input-hash (source files + prompt → regenerate when code changes) and an
  output-hash (published page content → detect external edits). A page whose
  output no longer matches what we last wrote is human-edited: it is skipped
  and reported, never clobbered. Modify/Supplement/Rewrite updates both hashes,
  so curated pages stay protected afterwards.
- **Zero-dependency YAML: strict subset parser.** `wiki_plan.yaml` uses a small,
  fixed schema (nested maps, string lists, string scalars). We parse exactly
  that subset with clear errors; `wiki_plan.json` is accepted as a full-JSON
  alternative. No new runtime dependency.

## Repo layout

```
open-repo-wiki/
├── generate.js, export.js, lib/, test/   # engine — layout unchanged
├── wiki-plan.schema.md                   # plan-file documentation
└── extension/                            # VSCode extension (TypeScript)
    ├── src/                              # commands, tree, webview, proc mgmt
    ├── engine-entry.js                   # NDJSON entry that loads lib/api.js
    ├── dist/extension.js                 # esbuild bundle (self-contained)
    ├── dist/webview/                     # marked, highlight.js, mermaid, CSS
    └── package.json                      # extension manifest
```

The extension bundles engine sources with esbuild (`external: ['node-llama-cpp']`
and the other optional natives stay outside). Setting `openRepoWiki.enginePath`
points the child process at a full engine install instead of the bundle, for
GGUF/native providers.

## Engine: `lib/api.js` + event protocol

Orchestration moves from `generate.js` into `lib/api.js`; the CLI becomes a thin
wrapper. Public surface:

```js
generateWiki(repoDir, opts)   // → { catalog, stats }; emits progress events
modifyWiki(repoDir, { pagePath, operation, instruction })
                              // operation ∈ 'modify' | 'supplement' | 'rewrite'
generateKnowledge(repoDir, opts)
```

All emit typed events (EventEmitter). CLI flag `--json-events` switches stdout
to pure NDJSON (no human logs; mutually exclusive modes):

```json
{"type":"run_started","model":"glm-free","language":"en"}
{"type":"page_done","path":"overview.md","ms":8421,"status":"regenerated|cached|protected"}
{"type":"page_retry","path":"guides/testing.md","attempt":2,"reason":"citation range"}
{"type":"run_finished","stats":{"regenerated":4,"cached":9,"protected":1}}
```

## Engine: parity features

### a) `wiki_plan.yaml` (repo root, committed; `wiki_plan.json` accepted)

Schema mirrors Qoder's:

```yaml
version: 1
repowiki:
  template: ""            # "architecture" | "product_requirement" | ""
  notes:                  # injected into the planning prompt
    - text: "Focus on business workflows, target new engineers"
      author: "enes"
  documents:              # strict page allowlist when present
    - title: "System Architecture Overview"
      goal: "Describe modules and interactions"
      parent: ""          # optional parent page title
      hints: ""           # optional writing hints
knowledgecard:
  notes: []
scope:
  include: []             # gitignore-syntax visibility filter
  exclude: []
```

Behavior:
- `scope` filters the scan before planning (extends existing scan filtering).
- `repowiki.notes` / `knowledgecard.notes` are injected into the plan prompts.
- `repowiki.documents`, when non-empty, switches planning to strict mode: the
  page list is exactly the listed documents (paths derived from titles, parents
  from `parent`); the LLM only assigns `files` per page; the deterministic
  source-coverage guarantee still applies within scope.
- `template` selects a preset prompt flavor for planning/writing.
- Editing the plan file requires an explicit regenerate (same as Qoder).

### b) Modify / Supplement / Rewrite

`modifyWiki` builds a prompt from: current page content + attached source files
(`catalog.json` `dependent_files`) + the user instruction + operation semantics
(modify = targeted edits; supplement = append new content only; rewrite = full
rewrite preserving the page's purpose). Output passes the same quality and
citation gates as normal generation, is written transactionally, and updates
both state hashes. CLI: `node generate.js --modify <path> --op supplement
--instruction "..."`.

### c) Manual-edit protection (dual hashes)

`state.pageMetadata[page]` gains `outputHash` next to the existing input hash.
On an incremental run: if input-hash changed (regeneration needed) but the live
file's content hash ≠ recorded output-hash, the page is reported as `protected`
and skipped — never overwritten. `--force` or an explicit rewrite operation
overwrites deliberately. No frontmatter markers; the mechanism is fully
git-visible and requires no reverse-sync machinery.

### d) Update vs Sync

- **Update** = incremental generation when input hashes drift (code changed).
- **Sync** = detection of externally edited wiki markdown (output-hash drift):
  the run reports "externally modified, skipped" instead of clobbering; the
  extension surfaces these as 🔒 protected pages.
- Qoder's limits are adopted as guards: warn above 10,000 scannable files; warn
  when the target is not a Git repo with at least one commit.

## Extension UX

**View container "Repo Wiki"** (activity bar), one tree view:

- Reads `.local-wiki/<lang>/meta/catalog.json`; hierarchical page tree.
- Icons: page / landing page / 🔒 protected. Welcome screen with "Generate
  Wiki" when no catalog exists.
- Header actions: ▶ Generate/Update · 🔄 Refresh · language picker · ⚙ settings.

**Webview preview:** single reused "Repo Wiki Preview" panel; GitHub-like theme
consistent with `export.js`; marked + highlight.js + mermaid shipped as webview
assets (not bundled through CJS — mermaid is ESM). Top bar: title, "Edit
source" (opens the raw `.md`; a manual edit then protects the page), protected
badge. Internal links navigate in-panel; external links open in the browser.

**Commands** (`openRepoWiki.*`):

| Command | Behavior |
|---|---|
| `generate` | Initial generation or incremental update; progress from NDJSON events; Cancel sends SIGTERM → transactional rollback |
| `modifyPage` | Quick pick page → operation → instruction input; runs modify op |
| `editPlan` | Opens `wiki_plan.yaml` (scaffolded from template if missing) |
| `exportPdf` | Runs bundled `export.js` → reveals `wiki-pdf/` |
| `selectModel` | Quick pick of engine config profiles |
| `showOutput` | Output channel with the event log |

**Change detection:** on file save (2s debounce), if the file is in some page's
`dependent_files`, show a status-bar item "Repo Wiki: update available" (click →
generate). `autoUpdate` setting: `notify` (default) | `auto` | `off` — LLM
calls never start without user intent unless `auto` is explicitly chosen.

**Settings:** `defaultModel`, `language`, `configPath`, `enginePath`,
`nodePath`, `autoUpdate`. One active engine run at a time; concurrent clicks
get a message. Node resolution: `nodePath` → `node` on PATH →
`process.execPath` with `ELECTRON_RUN_AS_NODE=1`.

## Testing

- Engine unit tests (existing patterns, mock-llm): plan-file parser (valid /
  invalid subset / JSON alt), scope filtering, dual-hash protection
  (externally edited page → skipped + reported), modify ops, NDJSON event
  sequence, strict-documents planning mode.
- Engine integration: full run with `wiki_plan` present; manual edit between
  runs; modify op updates state.
- Extension: strict TS compile as CI gate; unit tests for pure helpers (tree
  building from catalog, event→progress mapping); manual F5 smoke checklist in
  `extension/TESTING.md`.

## Packaging

esbuild produces `dist/extension.js` plus `dist/webview/` assets.
`vsce package` works from day one (local `.vsix` install). Marketplace later =
publisher account + icon + screenshots + CI, no code changes. Root
`package.json` and engine tests remain untouched; the extension has its own
`package.json` and dev dependencies.

## Out of scope (explicit)

- Web app / hosted UI (later phase, reuses `lib/api.js`).
- Team cloud sharing (Qoder Teams feature; Git sharing already works).
- Marketplace publishing (structure ready, done when wanted).
- Auto-reverse-sync of manual edits into knowledge cards (Git handles sharing;
  protection is enough).

## Implementation phases (high level; details in the plan doc)

1. `lib/api.js` extraction + NDJSON mode (CLI behavior unchanged).
2. Parity features: dual-hash protection, modify ops, `wiki_plan` file.
3. Extension scaffold: bundling, tree, commands, process management.
4. Extension UX: webview preview, change detection, settings, polish.
5. Packaging, smoke testing, README updates.
