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
const { planMessages, pageMessages, extractJson } = require('./lib/prompts');

const HELP = `Local Repo Wiki generator

Usage: node generate.js [repoDir] [options]

Options:
  -m, --model <name>    model profile from config (default: config "default")
  -o, --out <dir>       output dir (default: <repoDir>/.local-wiki/en/content)
  -c, --config <file>   config file (default: <repoDir>/repo-wiki.config.json,
                        then <appDir>/config.json)
      --pages <substr>  only (re)generate pages whose path contains substring
      --concurrency <n> pages generated in parallel (default: profile/config, else 1)
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

  const processPage = async (page) => {
    if (args.pages && !page.path.includes(args.pages)) { skipped++; return; }
    const outFile = path.join(outDir, page.path);
    const { block, attached } = buildFilesBlock(repoDir, page, scan, contextChars);
    const hash = sha1([
      modelName, language, page.title, page.description || '',
      ...attached.map(rel => { try { return sha1(fs.readFileSync(path.join(repoDir, rel))); } catch { return rel; } }),
    ].join('|'));

    if (!args.force && state.pages[page.path] === hash && fs.existsSync(outFile)) {
      skipped++;
      console.log(`  SKIP  ${page.path} (unchanged)`);
      return;
    }
    try {
      console.log(`  GEN   ${page.path} ...`);
      const raw = await chat(profile, pageMessages(scan, page, block, { language }), { maxTokens: profile.maxTokens });
      const md = unwrapMarkdown(raw);
      if (md.length < 50) throw new Error('suspiciously short page output');
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

  let nextIdx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (nextIdx < pages.length) await processPage(pages[nextIdx++]);
  }));

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

  console.log(`\nDone: ${ok} generated, ${skipped} skipped, ${failed} failed -> ${outDir}`);
  console.log(`Tip: export to PDF with  node ${path.join(__dirname, 'export.js')} ${outDir} ${path.join(repoDir, 'wiki-pdf')}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
