# Extension UI Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three UI upgrades for the extension: (1) live generation progress in the Wiki Pages tree header, (2) Qoder-style preview restyle with TOC sidebar, (3) gear-icon guided menu for model profiles/API keys (openai/anthropic/ollama aware, with key test).

**Architecture:** All inside `extension/`. Pure reducers/writers stay vscode-free and unit-tested; glue wires events/commands. Config writes target `<workspace>/repo-wiki.config.json` and `<workspace>/.env` (formats the engine already consumes). Worktree: `.worktrees/ui-round` on `feature/extension-ui`.

## Task 1: Live progress in the tree header

Files: `src/pure/treeStatus.ts` (new), `test/treeStatus.test.ts`, `src/extension.ts` (wire), `src/wikiTree.ts` (no change — use `TreeView.message`/`badge` from `createTreeView`).

`src/pure/treeStatus.ts`:
```ts
import type { WikiEvent } from './events.js';

export interface TreeStatus { message: string; badge?: number }

export function createTreeStatus(): {
  step: (event: WikiEvent) => TreeStatus | null;
  summary: (stats: { generated: number; degraded: number; skipped: number }, model: string): TreeStatus;
  clear: () => TreeStatus;
} {
  let total = 0;
  let done = 0;
  let running = false;
  return {
    step(event) {
      switch (event.type) {
        case 'run_started': { total = 0; done = 0; running = true; return { message: '⚡ Starting engine…', badge: 0 }; }
        case 'plan_ready': {
          total = Array.isArray(event.pages) ? event.pages.length : 0;
          done = 0;
          return { message: `⚡ Writing wiki — 0/${total} pages`, badge: 0 };
        }
        case 'page_done': case 'page_fail': {
          if (!running) return null;
          done += 1;
          const label = event.type === 'page_fail' ? `⚠ ${event.path}` : event.path;
          return { message: `⚡ ${done}/${total || '?'} · ${label}`, badge: done };
        }
        case 'run_finished': { running = false; return null; }
        default: return null;
      }
    },
    summary(stats, model) {
      const parts = [`✓ ${stats.generated + stats.skipped} pages`];
      if (stats.degraded) parts.push(`${stats.degraded} degraded`);
      return { message: `${parts.join(' · ')} · ${model}` };
    },
    clear() { return { message: '' }; },
  };
}
```

Wiring in extension.ts: use `vscode.window.createTreeView('openRepoWiki.pages', { treeDataProvider: tree })` (replace registerTreeDataProvider) to get the `TreeView` handle. In `runEngineWithProgress` onEvent: `const s = status.step(event); if (s) { view.message = s.message; if (s.badge !== undefined) view.badge = s.badge; }`. On success: `const s = status.summary(...)` → `view.message = s.message; view.badge = undefined`. On failure: `view.message = '✗ last run failed — see output'`. Reset badge to undefined on finish.

Test (test/treeStatus.test.ts): run_started → starting message; plan_ready pages 3 → 0/3; two page_done → 2/3 with badge 2; page_fail counts too; run_finished → null; summary text; clear.

Verify: typecheck + tests green; commit `feat: live generation progress in the wiki tree header`.

## Task 2: Preview restyle + TOC sidebar

Files: `src/preview.ts` (layout: TOC column + content column), `webview/page.css` (rewrite), `webview/webview.js` (TOC builder + anchor scrolling).

`buildHtml` body becomes:
```html
<body>
  <header id="topbar">…(unchanged)…</header>
  <div id="layout">
    <nav id="toc"><h3>On this page</h3><ul id="toc-list"></ul></nav>
    <main id="page"></main>
  </div>
  <script …/>
</body>
```

`webview/webview.js` additions after render:
```js
function buildToc(main) {
  const list = document.getElementById('toc-list');
  list.innerHTML = '';
  const headings = main.querySelectorAll('h2, h3');
  if (!headings.length) { document.getElementById('toc').style.display = 'none'; return; }
  document.getElementById('toc').style.display = '';
  headings.forEach((heading, index) => {
    if (!heading.id) heading.id = 'sec-' + index;
    const li = document.createElement('li');
    li.className = heading.tagName === 'H3' ? 'lvl3' : 'lvl2';
    const a = document.createElement('a');
    a.href = '#' + heading.id;
    a.textContent = heading.textContent;
    a.addEventListener('click', (e) => { e.preventDefault(); heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    li.appendChild(a);
    list.appendChild(li);
  });
}
```
Call `buildToc(main)` after link interception. Also add anchor ids to h2/h3 in content, and keep existing link handling for in-page `#` links (delegate to scrollIntoView of the target id).

`webview/page.css` rewrite (complete):
```css
:root { color-scheme: light dark; --border: var(--vscode-panel-border, #e2e8f0); --muted: var(--vscode-descriptionForeground, #64748b); }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Segoe UI', -apple-system, sans-serif; font-size: 14.5px; line-height: 1.65; }
#topbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; align-items: center; padding: 10px 20px; border-bottom: 1px solid var(--border); background: var(--vscode-sideBar-background, #fff); }
#title { font-weight: 650; font-size: 15px; }
#badges .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background, #475569); color: var(--vscode-badge-foreground, #fff); margin-right: 4px; }
#edit-source { margin-left: auto; }
#layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 0; max-width: 1180px; margin: 0 auto; padding: 0 24px; }
#toc { border-right: 1px solid var(--border); padding: 24px 16px 48px 0; position: sticky; top: 57px; align-self: start; max-height: calc(100vh - 57px); overflow-y: auto; font-size: 12.5px; }
#toc h3 { margin: 0 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
#toc ul { list-style: none; margin: 0; padding: 0; }
#toc li { margin: 2px 0; }
#toc li.lvl3 { padding-left: 14px; }
#toc a { color: var(--muted); text-decoration: none; display: block; padding: 3px 6px; border-radius: 4px; }
#toc a:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
main { padding: 28px 8px 72px 28px; max-width: 820px; }
main h1 { font-size: 26px; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin: 0 0 18px; }
main h2 { font-size: 20px; font-weight: 650; margin-top: 36px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
main h3 { font-size: 16px; font-weight: 600; margin-top: 26px; }
main p { margin: 12px 0; }
main a { color: var(--vscode-textLink-foreground, #2563eb); text-decoration: none; } main a:hover { text-decoration: underline; }
main ul, main ol { padding-left: 24px; } main li { margin: 4px 0; }
.code-frame { position: relative; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); margin: 16px 0; }
.code-frame .lang { position: absolute; top: 0; right: 0; font-size: 10.5px; font-family: ui-monospace, monospace; color: #94a3b8; background: rgba(127,127,127,.08); padding: 2px 10px; border-bottom-left-radius: 8px; }
main pre { background: var(--vscode-textCodeBlock-background, #0f172a); margin: 0; padding: 14px 16px; overflow-x: auto; }
main pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; }
main :not(pre) > code { font-family: ui-monospace, monospace; font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); padding: 2px 6px; border-radius: 4px; }
main table { border-collapse: collapse; margin: 16px 0; font-size: 13.5px; }
main th, main td { border: 1px solid var(--border); padding: 8px 14px; text-align: left; }
main tr:nth-child(even) td { background: rgba(127,127,127,.05); }
main blockquote { border-left: 3px solid var(--vscode-textLink-foreground, #2563eb); background: rgba(127,127,127,.06); margin: 16px 0; padding: 10px 16px; border-radius: 0 6px 6px 0; color: var(--muted); }
main img { max-width: 100%; border-radius: 6px; }
main .mermaid-frame { border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin: 16px 0; background: var(--vscode-editor-background, transparent); text-align: center; }
main hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
@media (max-width: 900px) { #layout { grid-template-columns: minmax(0,1fr); } #toc { display: none; } main { padding-left: 8px; } }
```

`webview/webview.js` render additions: wrap each `pre` into `.code-frame` with a `.lang` label read from the first code child's class (`language-xyz`); wrap mermaid pre content div into `.mermaid-frame` (mermaid.run target — simplest: wrap the whole pre in the frame div; mermaid renders inside). Implementation order: create frame wrapper around each pre BEFORE hljs; extract lang from `code.className.match(/language-([\w+-]+)/)`.

Verify: compile + tests; commit `feat: qoder-style preview with toc sidebar and framed code blocks`.

## Task 3: Gear menu — guided model manager

Files: `src/pure/modelStore.ts` (new), `src/pure/apiProbe.ts` (new), `test/modelStore.test.ts`, `test/apiProbe.test.ts` (fetch-mocked), `src/extension.ts` (rewrite openSettings command).

`src/pure/modelStore.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProviderKind = 'openai' | 'anthropic' | 'ollama';
export interface ManagedProfile {
  name: string; provider: ProviderKind; baseUrl: string; model: string;
  maxTokens?: number; concurrency?: number; think?: boolean;
}

export function readManagedConfig(configPath: string): { default?: string; models: Record<string, ManagedProfile & { apiKey?: string }> } {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { default: raw.default, models: raw.models && typeof raw.models === 'object' ? raw.models : {} };
  } catch { return { models: {} }; }
}

export function writeManagedConfig(configPath: string, config: { default?: string; models: Record<string, unknown> }): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function writeApiKey(envPath: string, varName: string, key: string): void {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* new */ }
  const rx = new RegExp(`^${varName}=.*$`, 'm');
  const line = `${varName}=${key}`;
  const next = rx.test(text) ? text.replace(rx, line) : (text.endsWith('\n') || !text ? text + line : text + '\n' + line);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, next.endsWith('\n') || !next ? next : next + '\n');
}

export function envVarNameFor(profileName: string): string {
  const base = profileName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `REPO_WIKI_KEY_${base}`;
}

export function profileToEngineConfig(profile: ManagedProfile): Record<string, unknown> {
  return {
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: `env:${envVarNameFor(profile.name)}`,
    maxTokens: profile.maxTokens ?? 16384,
    ...(profile.concurrency ? { concurrency: profile.concurrency } : {}),
    ...(profile.think === false ? { think: false } : {}),
  };
}
```

`src/pure/apiProbe.ts`:
```ts
import { resolveApiKey } from './envResolve.js';

export async function probeOpenAI(baseUrl: string, apiKey: string, model: string, timeoutMs = 20000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok && text.includes('"content"') ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}

export async function probeAnthropic(baseUrl: string, apiKey: string, model: string, timeoutMs = 20000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 16, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok && text.includes('"text"') ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}

export async function probeOllama(baseUrl: string, model: string, timeoutMs = 10000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], stream: false, think: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}
```
Note `resolveApiKey` lives in lib/providers.js (engine, CJS). Do NOT import engine code into the extension — the extension never imports engine code in-process. apiProbe is self-contained; drop the resolveApiKey import (unused). KEY VALUES stay in memory only to be written to .env; never logged.

`src/extension.ts` — replace openSettings handler with `showSettingsMenu(context, tree)`:
1. QuickPick items: `➕ Add / edit model…`, `🔑 Set API key…`, `🤖 Select model…`, `⚙️ All settings…`.
2. Add/edit flow:
   - Pick provider kind: OpenAI-compatible / Anthropic-compatible / Ollama (local).
   - Input name (default suggestion based on kind).
   - If editing existing name (from managed config) prefill.
   - Base URL prompt with kind-specific default: openai `https://open.bigmodel.cn/api/paas/v4`… actually defaults: openai → `http://localhost:1234/v1`, anthropic → `https://open.bigmodel.cn/api/anthropic`, ollama → `http://localhost:11434`.
   - Model id input.
   - API key password input: openai/anthropic required-ish (allow empty for local openai servers — show "(optional for local servers)"), ollama skipped.
   - Offer `Test` (quick pick Yes/No after entering key): run matching probe; show result; on fail allow retry of key input.
   - Save: `writeManagedConfig(repo/repo-wiki.config.json, …)` merging into existing managed models (profileToEngineConfig + apiKey env ref) and `writeApiKey(repo/.env, envVarNameFor(name), key)`; set `default` if it was empty.
   - Info message: "Saved <name> → repo-wiki.config.json + .env (gitignored)". If .env is not gitignored in that repo, warn.
3. Set API key flow: quick pick from managed profiles → password input → probe → save.
4. Select model → existing selectModel command; All settings → `workbench.action.openSettings` filtered.

Managed config file: `<workspaceRoot>/repo-wiki.config.json` (engine discovery order: repo repo-wiki.config.json BEFORE app config — the managed file wins). WARN: if the file already exists with non-managed content, still merge into models map (documented in code comment).

Tests: modelStore read/write round-trip incl. .env replace + append; envVarNameFor; profileToEngineConfig shape; apiProbe both providers via mocked global.fetch (ok/429/abort).

Verify: typecheck + tests; commit `feat: guided model manager with api key storage and live probes`.

## Task 4: QA + packaging + docs

- Full `npm test` (extension) + engine `npm test` at root.
- `npm run compile`, `npm run package` → .vsix builds.
- Update extension/README.md (gear menu section, progress header, preview screenshot placeholder) + TESTING.md items.
- Root README: one line under VSCode section.
- Commit `docs: extension ui round readme updates`.

## Self-review checklist
- TreeView.message/badge API availability: TreeView.message (stable), TreeView.badge (VSCode 1.85+, guarded — engines.vscode is ^1.80: wrap badge usage in try or check `('badge' in view)`; message alone is the core value).
- No engine code imported into the extension (apiProbe self-contained; duplicated shapes are small and stable).
- Keys never appear in output channel or logs.
- Preview CSP unchanged (no new origins).
