# Open Repo Wiki — VS Code extension

Generate, browse, and edit an AI documentation wiki for any repository, using
any LLM backend (local or online) that the engine supports.

<!-- TODO(marketplace): add a screenshot before publishing.
     Drop a PNG at media/screenshot.png and uncomment:
     ![screenshot](media/screenshot.png)
-->

## What it does

- **Generate / update** an any-LLM wiki for the open workspace (same engine and
  config profiles as the CLI: OpenAI-compatible, Ollama, llama.cpp server, GGUF).
- **Browse** pages in the "Wiki Pages" tree view and open a **preview** with
  rendered **mermaid** diagrams and syntax-highlighted code blocks.
- **Protect manual edits** — pages you hand-edit are marked 🔒 and are never
  silently overwritten by a later generation run.
- **Modify / supplement / rewrite** a single page through a guided flow without
  regenerating the whole wiki.
- **Export** the wiki to styled **PDFs** (per page + combined with table of
  contents).

## Install from `.vsix`

```bash
cd extension
npm install
npm run package          # → open-repo-wiki-0.1.0.vsix
```

In VS Code: **F1 → Extensions: Install from VSIX…** and select
`open-repo-wiki-0.1.0.vsix`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `openRepoWiki.defaultModel` | `""` | Model profile from the engine config (empty = engine default). |
| `openRepoWiki.language` | `en` | Wiki output language (used for the `.local-wiki/<lang>` directory). |
| `openRepoWiki.configPath` | `""` | Path to a `repo-wiki.config.json` (empty = engine auto-discovery). |
| `openRepoWiki.enginePath` | `""` | Full engine install (folder containing `generate.js`). Empty = monorepo checkout or bundled engine. |
| `openRepoWiki.nodePath` | `""` | Node binary for the engine child process (empty = `node` from PATH, then VS Code's builtin). |
| `openRepoWiki.autoUpdate` | `notify` | What to do when a saved source file belongs to a wiki page: `notify` (status-bar hint), `auto` (run generation), or `off`. |

## Commands

| Command | Title | Description |
|---|---|---|
| `openRepoWiki.generate` | Repo Wiki: Generate / Update Wiki | Generate or update the wiki for the current workspace. |
| `openRepoWiki.refreshTree` | Repo Wiki: Refresh | Re-read the catalog and refresh the wiki tree. |
| `openRepoWiki.openSettings` | Repo Wiki: Settings | Open the `openRepoWiki` settings. |
| `openRepoWiki.selectLanguage` | Repo Wiki: Select Language | Choose the wiki output language. |
| `openRepoWiki.modifyPage` | Repo Wiki: Modify Page… | Modify, supplement, or rewrite one page. |
| `openRepoWiki.editPlan` | Repo Wiki: Edit wiki_plan.yaml | Scaffold (if missing) and open the wiki plan file. |
| `openRepoWiki.exportPdf` | Repo Wiki: Export to PDF | Export the wiki to PDFs. |
| `openRepoWiki.selectModel` | Repo Wiki: Select Model Profile | Pick the default model profile from the engine config. |
| `openRepoWiki.showOutput` | Repo Wiki: Show Engine Output | Show the engine child-process output channel. |
| `openRepoWiki.openPage` | Repo Wiki: Open Page | Open a page in the preview (also invoked from the tree). |

## Engine resolution order

The extension runs the same engine as the CLI. It resolves the engine entry
points in this priority order:

1. `openRepoWiki.enginePath` setting (a folder containing `generate.js` /
   `export.js`).
2. A monorepo checkout next to the extension (`../generate.js` relative to the
   extension install).
3. The **bundled** engine at `dist/engine/*.cjs` shipped inside the extension.

## PDF export dependencies

PDF export (`Export to PDF`) needs the engine's optional packages
**`playwright` + `pdf-lib`** resolvable next to the engine script — i.e. in the
engine install's `node_modules` (run `npm install` in a full engine checkout).
If they are missing, the command shows a guidance message instead of failing.
The bundled engine intentionally omits these optional natives.
