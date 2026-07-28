#!/usr/bin/env node
/**
 * Local Repo Wiki generator — standalone application.
 *
 * Analyzes a repository and generates a documentation wiki (markdown with
 * mermaid diagrams) using any configured AI backend:
 *   - OpenAI-compatible APIs: local (Ollama/LM Studio/llama.cpp server/vLLM)
 *     or online (Zhipu GLM, Moonshot Kimi, ...)
 *   - native Ollama API
 *   - direct in-process GGUF inference (node-llama-cpp), no server needed
 *
 * Fully offline when a local backend is selected. Incremental: unchanged
 * pages are skipped on re-runs, stale pages are removed.
 *
 * Usage: node generate.js [repoDir] [options]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scanRepo } = require('./lib/scan');
const { chat, resolveApiKey } = require('./lib/providers');
const { planMessages, pageMessages, knowledgeMessages, KNOWLEDGE_CARDS, extractJson } = require('./lib/prompts');
const { moduleMap, titleCase } = require('./lib/modules');
const { sanitizeCitations } = require('./lib/citations');

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
      --knowledge       also generate the structured knowledge-card layer.
                        Written to <root>/knowledge/<lang> (a sibling of the
                        content-language dir, mirroring Qoder's repowiki layout);
                        assumes the default <root>/<lang>/content output tree. With
                        a custom flat --out the tree is placed two levels up from
                        --out and may fall outside it.
      --force           regenerate everything, ignore the incremental cache
      --dry-run         print the wiki plan and exit without writing pages
      --list-models     list configured model profiles and exit
  -h, --help            show this help

Environment: REPO_WIKI_MODEL overrides the default model profile.

Export to PDF afterwards with the bundled exporter:
  node export.js <repoDir>/.local-wiki/en/content <repoDir>/wiki-pdf`;

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
    else if (a === '--list-models') args.listModels = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function loadConfig(args, repoDir) {
  const candidates = [
    args.config,
    path.join(repoDir, 'repo-wiki.config.json'),
    path.join(__dirname, 'config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return { config: JSON.parse(fs.readFileSync(p, 'utf8')), configPath: p };
      } catch (err) {
        console.error(`Invalid JSON in ${p}: ${err.message}`);
        process.exit(1);
      }
    }
  }
  console.error('No config file found.');
  process.exit(1);
}

function pickProfile(config, args) {
  const name = args.model || process.env.REPO_WIKI_MODEL || config.default;
  const profile = config.models && config.models[name];
  if (!profile) {
    console.error(`Model profile '${name}' not found. Available: ${Object.keys(config.models || {}).join(', ')}`);
    process.exit(1);
  }
  return { name, profile };
}

function listModels(config) {
  console.log('Configured model profiles:\n');
  for (const [name, p] of Object.entries(config.models || {})) {
    const target = p.provider === 'llamacpp' ? p.modelPath : `${p.model} @ ${p.baseUrl}`;
    const key = p.apiKey ? (resolveApiKey(p.apiKey) ? 'key: set' : `key: MISSING (${p.apiKey})`) : 'no key needed';
    const mark = name === config.default ? '*' : ' ';
    console.log(`${mark} ${name.padEnd(18)} ${p.provider.padEnd(9)} ${target}  [${key}]`);
  }
  console.log('\n(* = default; select with --model <name> or REPO_WIKI_MODEL)');
}

function sanitizePagePath(p) {
  const clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
    .split('/').filter(seg => seg && seg !== '.' && seg !== '..')
    .map(seg => seg.replace(/[^\w.\- ]/g, '_'))
    .join('/');
  if (!clean) return null;
  return clean.toLowerCase().endsWith('.md') ? clean : clean + '.md';
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// Strip a single wrapping ```markdown fence some models add around the page
function unwrapMarkdown(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

function buildFilesBlock(repoDir, page, scan, budget) {
  const PER_FILE_CAP = 24000;
  const parts = [];
  let used = 0;
  const attached = [];
  for (const rel of page.files || []) {
    if (!scan.fileSet.has(rel)) continue; // model hallucinated a path — drop it
    if (used >= budget) break;
    let content;
    try { content = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { continue; }
    let truncated = false;
    const room = Math.min(PER_FILE_CAP, budget - used);
    if (content.length > room) { content = content.slice(0, room); truncated = true; }
    used += content.length;
    attached.push(rel);
    parts.push(`--- ${rel}${truncated ? ' (truncated)' : ''} ---\n${content}`);
  }
  return { block: parts.join('\n\n'), attached };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  const repoDir = path.resolve(args._[0] || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    console.error(`Repository directory not found: ${repoDir}`);
    process.exit(1);
  }

  const { config, configPath } = loadConfig(args, repoDir);
  if (args.listModels) { listModels(config); process.exit(0); }

  const { name: modelName, profile } = pickProfile(config, args);
  const outDir = path.resolve(args.out || path.join(repoDir, '.local-wiki/en/content'));
  const statePath = path.join(outDir, '.state.json');
  const maxPages = config.maxPages || 20;
  const language = config.language || 'en';
  const contextChars = profile.contextChars || 24000;
  const template = args.template || config.template || 'standard';
  // Sibling output trees derived from the content dir: <content>/../meta and
  // <root>/knowledge/<lang> (mirrors Qoder's repowiki layout). metaDir is kept as
  // the direct sibling of the content dir so export.js (which resolves the catalog
  // at <SRC>/../meta) finds it for ANY --out location, not just the default tree.
  const localWikiRoot = path.resolve(outDir, '..', '..');
  const metaDir = path.join(outDir, '..', 'meta');
  const knowledgeBase = path.join(localWikiRoot, 'knowledge', language);

  console.log(`Repo:   ${repoDir}`);
  console.log(`Model:  ${modelName} (${profile.provider}: ${profile.model || profile.modelPath})`);
  console.log(`Config: ${configPath}`);
  console.log(`Out:    ${outDir}\n`);

  console.log('Scanning repository...');
  const scan = scanRepo(repoDir);
  if (scan.files.length === 0) {
    console.error('No readable source files found — nothing to document.');
    process.exit(1);
  }
  console.log(`  ${scan.files.length} files considered\n`);

  // --- Stage 1: wiki structure plan ---
  console.log('Planning wiki structure...');
  const planRaw = await chat(profile, planMessages(scan, { maxPages }), { maxTokens: profile.maxTokens });
  let plan;
  try {
    plan = extractJson(planRaw);
  } catch (err) {
    const dump = path.join(repoDir, '.local-wiki-plan-error.txt');
    fs.mkdirSync(path.dirname(dump), { recursive: true });
    fs.writeFileSync(dump, planRaw);
    console.error(`Plan failed: ${err.message} (raw output saved to ${dump})`);
    process.exit(1);
  }
  const seenPaths = new Set();
  const pages = (Array.isArray(plan.pages) ? plan.pages : [])
    .map(p => ({ ...p, path: sanitizePagePath(p.path) }))
    .filter(p => p.path && p.title && !seenPaths.has(p.path) && seenPaths.add(p.path))
    .slice(0, maxPages);
  if (pages.length === 0) {
    console.error('Model returned an empty/unusable plan.');
    process.exit(1);
  }
  console.log(`  ${pages.length} pages planned:`);
  for (const p of pages) console.log(`    - ${p.path}  (${p.title})`);

  if (args.dryRun) {
    console.log('\nDry run — no pages written.');
    process.exit(0);
  }

  // --- Stage 2: generate pages (incremental, optionally parallel) ---
  fs.mkdirSync(outDir, { recursive: true });
  let state = { model: modelName, pages: {} };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  if (!state.pages) state.pages = {};
  // State is persisted after every page so an interrupted run resumes where it stopped
  const saveState = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  };

  const concurrency = Math.max(1, parseInt(args.concurrency, 10)
    || profile.concurrency || config.concurrency || 1);
  if (concurrency > 1) console.log(`  concurrency: ${concurrency}`);

  let ok = 0, skipped = 0, failed = 0;
  const currentPaths = new Set(pages.map(p => p.path));

  // Landing pages (a "dir/dir.md" or "dir/index.md" heading a multi-page
  // subdirectory) are generated AFTER their children so the summary can link
  // the real child pages. Enrich their focus with the concrete child list first.
  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); };
  const baseNoExt = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const pagesByDir = new Map();
  for (const p of pages) {
    const d = dirOf(p.path);
    if (!pagesByDir.has(d)) pagesByDir.set(d, []);
    pagesByDir.get(d).push(p);
  }
  for (const p of pages) {
    const d = dirOf(p.path);
    if (!d) continue;
    const dirLast = d.slice(d.lastIndexOf('/') + 1);
    const bn = baseNoExt(p.path);
    if (bn !== dirLast && bn !== 'index') continue;
    const children = (pagesByDir.get(d) || []).filter(s => s.path !== p.path);
    if (children.length === 0) continue;
    p._landing = true;
    p._children = children;
    p._desc0 = p.description;
    const links = children
      .map(c => `- [${c.title}](${c.path.slice(c.path.lastIndexOf('/') + 1)})`)
      .join('\n');
    p.description = `${p.description || p.title}\n\nThis is the landing page for the "${d}" section. Introduce the section briefly, then link to each child page:\n${links}`;
  }
  const mainPages = pages.filter(p => !p._landing);
  const landingPages = pages.filter(p => p._landing);

  const processPage = async (page) => {
    if (args.pages && !page.path.includes(args.pages)) { skipped++; return; }
    const outFile = path.join(outDir, page.path);
    const { block, attached } = buildFilesBlock(repoDir, page, scan, contextChars);
    // Record the validated (real, attached) subset so the catalog cites only
    // files that actually reached the model — never the plan's raw wish-list,
    // which may still contain hallucinated paths.
    page._attached = attached;
    const hash = sha1([
      modelName, language, template, page.title, page.description || '',
      ...attached.map(rel => { try { return sha1(fs.readFileSync(path.join(repoDir, rel))); } catch { return rel; } }),
    ].join('|'));

    if (!args.force && state.pages[page.path] === hash && fs.existsSync(outFile)) {
      skipped++;
      console.log(`  SKIP  ${page.path} (unchanged)`);
      return;
    }
    try {
      console.log(`  GEN   ${page.path} ...`);
      const raw = await chat(profile, pageMessages(scan, page, block, { language, attached, template }), { maxTokens: profile.maxTokens });
      let md = unwrapMarkdown(raw);
      if (md.length < 50) throw new Error('suspiciously short page output');
      // Output-side guard: strip any structured citation the model may have
      // emitted to a path we never attached (input filtering can't catch this).
      if (attached.length) {
        const san = sanitizeCitations(md, attached);
        md = san.md;
        if (san.dropped) console.log(`  note  ${page.path}: dropped ${san.dropped} ungrounded citation(s)`);
      }
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, md + '\n');
      state.pages[page.path] = hash;
      saveState();
      ok++;
      console.log(`  OK    ${page.path} (${md.length} chars, ${attached.length} source files)`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${page.path}: ${err.message.split('\n')[0]}`);
    }
  };

  const runPool = async (list) => {
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (idx < list.length) await processPage(list[idx++]);
    }));
  };
  await runPool(mainPages);   // children first
  await runPool(landingPages); // then section landing pages that link them

  // --- Remove stale pages (dropped from the plan since the last run) ---
  for (const rel of Object.keys(state.pages)) {
    if (!currentPaths.has(rel)) {
      const full = path.join(outDir, rel);
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        console.log(`  removed stale: ${rel}`);
      }
      delete state.pages[rel];
    }
  }
  // prune now-empty subdirectories
  const pruneEmpty = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        pruneEmpty(full);
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      }
    }
  };
  pruneEmpty(outDir);

  state.model = modelName;
  state.generatedAt = new Date().toISOString();
  saveState();

  // --- Catalog + navigable index (meta layer) ---
  const landingByDir = new Map();
  for (const p of pages) if (p._landing) landingByDir.set(dirOf(p.path), p.path);
  const catalog = {
    repo: scan.name,
    model: modelName,
    language,
    generatedAt: state.generatedAt,
    pages: pages.map(p => {
      const d = dirOf(p.path);
      const parent = (!p._landing && landingByDir.has(d)) ? landingByDir.get(d) : null;
      return {
        path: p.path,
        title: p.title,
        description: p._desc0 || p.description || '',
        // Real files that reached the model, not the plan's raw list (which may
        // still name paths that don't exist in the repo).
        dependent_files: p._attached || (p.files || []).filter(f => scan.fileSet.has(f)),
        parent,
        isLanding: !!p._landing,
      };
    }),
  };
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'catalog.json'), JSON.stringify(catalog, null, 2));

  // Human-navigable index that works in any markdown viewer.
  const idx = [`# ${scan.name} — Wiki`, ''];
  for (const p of pages.filter(pg => !dirOf(pg.path))) idx.push(`- [${p.title}](${p.path})`);
  for (const d of [...pagesByDir.keys()].filter(Boolean).sort()) {
    const group = pagesByDir.get(d);
    const landing = group.find(p => p._landing);
    const children = group.filter(p => !p._landing);
    if (landing) {
      idx.push(`- [${landing.title}](${landing.path})`);
      for (const c of children) idx.push(`  - [${c.title}](${c.path})`);
    } else {
      idx.push(`- **${titleCase(d)}**`);
      for (const c of children) idx.push(`  - [${c.title}](${c.path})`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'index.md'), idx.join('\n') + '\n');
  console.log(`  catalog + index written -> ${path.relative(repoDir, metaDir)}`);

  // --- Optional knowledge-card layer (opt-in via --knowledge / config.knowledge) ---
  if (args.knowledge || config.knowledge) {
    console.log('\nGenerating knowledge cards...');
    const modules = moduleMap(scan);
    const cardNames = Object.keys(KNOWLEDGE_CARDS);
    fs.mkdirSync(knowledgeBase, { recursive: true });
    const yaml = [
      'schema_version: 1',
      `locale: ${language}`,
      `generated_at: "${state.generatedAt}"`,
      'nodes_managed: true',
      'modules:',
    ];
    for (const m of modules) {
      yaml.push(`    "${m.key}":`);
      yaml.push(`        dir_name: ${m.dir}`);
      yaml.push(`        title: ${m.title}`);
      yaml.push('        scope:');
      for (const f of m.scope) yaml.push(`            - ${f}`);
      yaml.push('        children:');
      for (const c of m.children) yaml.push(`            - ${c}`);
    }
    fs.writeFileSync(path.join(knowledgeBase, '_index.yaml'), yaml.join('\n') + '\n');

    let kok = 0, kfail = 0;
    for (const m of modules) {
      const dir = path.join(knowledgeBase, m.dir);
      fs.mkdirSync(dir, { recursive: true });
      const mod = [
        'schema_version: 1',
        `module_path: "${m.path}"`,
        `title: ${m.title}`,
        'scope:',
        ...m.scope.map(f => `    - ${f}`),
      ];
      fs.writeFileSync(path.join(dir, '_module.yaml'), mod.join('\n') + '\n');
      const { block, attached } = buildFilesBlock(repoDir, { files: m.scope }, scan, contextChars);
      for (const card of cardNames) {
        try {
          const raw = await chat(profile, knowledgeMessages(scan, m, block, { language, card }), { maxTokens: profile.maxTokens });
          fs.writeFileSync(path.join(dir, `${card}.md`), unwrapMarkdown(raw) + '\n');
          kok++;
        } catch (err) {
          kfail++;
          console.log(`  FAIL  ${m.dir}/${card}: ${err.message.split('\n')[0]}`);
        }
      }
      console.log(`  card set: ${m.dir} (${attached.length} source files)`);
    }
    console.log(`  knowledge: ${kok} cards written, ${kfail} failed -> ${path.relative(repoDir, knowledgeBase)}`);
  }

  console.log(`\nDone: ${ok} generated, ${skipped} skipped, ${failed} failed -> ${outDir}`);
  console.log(`Tip: export to PDF with  node ${path.join(__dirname, 'export.js')} ${outDir} ${path.join(repoDir, 'wiki-pdf')}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
