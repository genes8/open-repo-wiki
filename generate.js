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
const {
  planMessages,
  pageMessages,
  repairPageMessages,
  knowledgeMessages,
  KNOWLEDGE_CARDS,
  extractJson,
} = require('./lib/prompts');
const { moduleMap, titleCase } = require('./lib/modules');
const { sanitizeCitations } = require('./lib/citations');
const { normalizePlan, dirOf, groupPages } = require('./lib/plan');
const { buildFilesBlock } = require('./lib/sources');
const { classifyPage, validatePage } = require('./lib/quality');
const {
  buildKnowledgePlan,
  cleanupManagedKnowledge,
  loadManifest,
  renderFrontmatter,
  safeManagedPath,
  validateKnowledgeContent,
  writeManifest,
} = require('./lib/knowledge');

const GENERATION_SCHEMA_VERSION = 2;

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
                        content-language dir, mirroring Qoder's repowiki layout)
                        when the default <root>/<lang>/content tree is used;
                        with a custom --out it stays contained inside
                        <out>/.knowledge/<lang> (meta likewise in <out>/.meta).
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

// Zero-dependency .env loader. Reads KEY=VALUE lines from <repoDir>/.env then
// <appDir>/.env into process.env WITHOUT overriding vars already set in the real
// environment (real env always wins). Keeps secrets out of the committed config:
// config.json only references env var NAMES ("env:ZHIPU_API_KEY"), the values
// live in an untracked .env file. Supports optional `export ` prefix, # comments,
// and single/double quoted values.
function loadDotenv(repoDir) {
  const files = [path.join(repoDir, '.env'), path.join(__dirname, '.env')];
  let loaded = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.slice(7).trim();
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
      loaded++;
    }
  }
  if (loaded) console.log(`  loaded .env (${loaded} var${loaded === 1 ? '' : 's'})`);
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

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// Strip a single wrapping ```markdown fence some models add around the page
function unwrapMarkdown(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function canonicalRelativePath(value, { markdown = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw
    || raw.includes('\\')
    || raw.includes('\0')
    || path.posix.isAbsolute(raw)
    || path.win32.isAbsolute(raw)
    || path.posix.normalize(raw) !== raw
    || raw === '.'
    || (markdown && !raw.toLowerCase().endsWith('.md'))) {
    return null;
  }
  return raw;
}

function normalizePublishedMetadata(value, fallbackPath = '') {
  if (!value || typeof value !== 'object') return null;
  const pagePath = canonicalRelativePath(fallbackPath || value.path, { markdown: true });
  const title = String(value.title || '').trim();
  if (!pagePath || !title) return null;
  if (fallbackPath && value.path
    && canonicalRelativePath(value.path, { markdown: true }) !== pagePath) {
    return null;
  }
  return {
    path: pagePath,
    title,
    description: String(value.description || ''),
    dependent_files: [...new Set(
      (Array.isArray(value.dependent_files) ? value.dependent_files : [])
        .map(file => canonicalRelativePath(file))
        .filter(Boolean)
    )],
    isLanding: value.isLanding === true,
    quality: value.quality === 'degraded' ? 'degraded' : 'ok',
    child_paths: [...new Set(
      (Array.isArray(value.child_paths) ? value.child_paths : [])
        .map(child => canonicalRelativePath(child, { markdown: true }))
        .filter(Boolean)
    )],
  };
}

function metadataFromCatalog(metaDir) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(metaDir, 'catalog.json'), 'utf8'));
  } catch {
    return new Map();
  }
  const result = new Map();
  for (const page of Array.isArray(catalog.pages) ? catalog.pages : []) {
    const metadata = normalizePublishedMetadata(page);
    if (metadata) result.set(metadata.path, metadata);
  }
  for (const page of Array.isArray(catalog.pages) ? catalog.pages : []) {
    const parent = canonicalRelativePath(page && page.parent, { markdown: true });
    const childPath = canonicalRelativePath(page && page.path, { markdown: true });
    const parentMetadata = result.get(parent);
    if (parentMetadata && childPath && !parentMetadata.child_paths.includes(childPath)) {
      parentMetadata.child_paths.push(childPath);
    }
  }
  return result;
}

function snapshotPageMetadata(page, attached) {
  return {
    path: page.path,
    title: page.title,
    description: page._desc0 || page.description || '',
    dependent_files: [...attached],
    isLanding: !!page._landing,
    quality: 'ok',
    child_paths: (page._children || []).map(child => child.path),
  };
}

function collectKnowledgeEvidence(repoDir, scan) {
  const MAX_TOTAL = 4 * 1024 * 1024;
  const MAX_PER_FILE = 64 * 1024;
  const evidence = {};
  let used = 0;
  for (const file of scan.files) {
    if (used >= MAX_TOTAL) break;
    const room = Math.min(MAX_PER_FILE, MAX_TOTAL - used);
    try {
      const content = fs.readFileSync(path.join(repoDir, file.rel), 'utf8').slice(0, room);
      evidence[file.rel] = content;
      used += content.length;
    } catch {
      // A file may disappear after the scan; omit it from topic evidence.
    }
  }
  return evidence;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  const repoDir = path.resolve(args._[0] || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    console.error(`Repository directory not found: ${repoDir}`);
    process.exit(1);
  }

  loadDotenv(repoDir); // populate process.env from .env before any key resolution

  const { config, configPath } = loadConfig(args, repoDir);
  if (args.listModels) { listModels(config); process.exit(0); }

  const { name: modelName, profile } = pickProfile(config, args);
  const outDir = path.resolve(args.out || path.join(repoDir, '.local-wiki/en/content'));
  const statePath = path.join(outDir, '.state.json');
  const maxPages = config.maxPages || 20;
  const language = config.language || 'en';
  const contextChars = profile.contextChars || 24000;
  const template = args.template || config.template || 'standard';
  // Output layout. The default tree mirrors Qoder's repowiki layout with meta
  // and knowledge as siblings of the content dir. A custom --out that is not a
  // .../content dir keeps both trees INSIDE the output dir (dot-dirs), so a
  // run never writes outside the location the user chose (e.g. --out /tmp/x
  // must not create /tmp/meta). export.js checks both catalog locations.
  const standardLayout = path.basename(outDir) === 'content';
  const localWikiRoot = path.resolve(outDir, '..', '..');
  const metaDir = standardLayout
    ? path.join(outDir, '..', 'meta')
    : path.join(outDir, '.meta');
  const knowledgeBase = standardLayout
    ? path.join(localWikiRoot, 'knowledge', language)
    : path.join(outDir, '.knowledge', language);

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

  // Prior state/catalog are loaded before planning so the planner can be
  // anchored on previously published pages (stable paths and titles across
  // runs, no destructive re-plans from LLM non-determinism).
  let state = { model: modelName, pages: {} };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  if (!state.pages) state.pages = {};
  if (!state.pageMetadata || typeof state.pageMetadata !== 'object') {
    state.pageMetadata = {};
  }
  const priorMetadataByPath = metadataFromCatalog(metaDir);
  for (const [pagePath, value] of Object.entries(state.pageMetadata)) {
    const metadata = normalizePublishedMetadata(value, pagePath);
    if (metadata) priorMetadataByPath.set(pagePath, metadata);
  }
  state.pageMetadata = Object.fromEntries(priorMetadataByPath);

  // --- Stage 1: wiki structure plan ---
  console.log('Planning wiki structure...');
  // Lower bound scaled to repository size; a too-small plan is replanned so a
  // single weak LLM response cannot collapse a 16-page wiki into 6 pages.
  const minPages = Math.min(
    maxPages,
    Math.max(4, parseInt(config.minPages, 10) || Math.ceil(scan.files.length / 3))
  );
  const priorPages = [...priorMetadataByPath.values()]
    .map(metadata => ({ path: metadata.path, title: metadata.title }));
  let normalized = null;
  let lastPlanError = null;
  let lastPlanRaw = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const planRaw = await chat(
      profile,
      planMessages(scan, { maxPages, minPages, priorPages }),
      { maxTokens: profile.maxTokens }
    );
    let candidate;
    try {
      candidate = normalizePlan(extractJson(planRaw).pages, scan, { maxPages });
    } catch (err) {
      lastPlanError = err;
      lastPlanRaw = planRaw;
      console.log(`  plan attempt ${attempt + 1}/3 invalid: ${err.message}`);
      continue;
    }
    // Best-of: keep the largest valid plan seen across attempts.
    if (!normalized || candidate.pages.length > normalized.pages.length) {
      normalized = candidate;
    }
    if (normalized.pages.length >= minPages) break;
    if (attempt < 2) {
      console.log(
        `  plan attempt ${attempt + 1}/3: ${candidate.pages.length} pages `
        + `(< ${minPages}), replanning...`
      );
    }
  }
  if (!normalized) {
    const dump = path.join(repoDir, '.local-wiki-plan-error.txt');
    fs.mkdirSync(path.dirname(dump), { recursive: true });
    fs.writeFileSync(dump, lastPlanRaw);
    console.error(`Plan failed: ${lastPlanError.message} (raw output saved to ${dump})`);
    process.exit(1);
  }
  if (normalized.pages.length < minPages) {
    console.log(`  WARN plan stayed below ${minPages} pages after 3 attempts; continuing`);
  }
  const pages = normalized.pages;
  console.log(`  ${pages.length} pages planned:`);
  for (const p of pages) console.log(`    - ${p.path}  (${p.title})`);

  if (args.dryRun) {
    console.log('\nDry run — no pages written.');
    process.exit(0);
  }

  // --- Stage 2: generate pages (incremental, optionally parallel) ---
  fs.mkdirSync(outDir, { recursive: true });
  // State is persisted after every page so an interrupted run resumes where it stopped
  const saveState = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  };

  const concurrency = Math.max(1, parseInt(args.concurrency, 10)
    || profile.concurrency || config.concurrency || 1);
  if (concurrency > 1) console.log(`  concurrency: ${concurrency}`);

  let ok = 0, skipped = 0, degraded = 0, failed = 0;
  const currentPaths = new Set(pages.map(p => p.path));

  const mainPages = pages.filter(p => !p._landing);
  const landingPages = pages.filter(p => p._landing);

  const processPage = async (page) => {
    const outFile = path.join(outDir, page.path);
    const existingMetadata = priorMetadataByPath.get(page.path) || null;
    page._publishedMetadata = fs.existsSync(outFile) ? existingMetadata : null;
    page._published = !!page._publishedMetadata;
    const generationPage = page._landing
      ? {
        ...page,
        _children: (page._children || [])
          .filter(child => child._publishedMetadata)
          .map(child => ({
            ...child,
            path: child._publishedMetadata.path,
            title: child._publishedMetadata.title,
            description: child._publishedMetadata.description,
          })),
      }
      : page;
    const {
      block,
      attached,
      lineCounts,
      rawByPath,
    } = buildFilesBlock(repoDir, generationPage, scan, contextChars);
    // Record the validated (real, attached) subset so the catalog cites only
    // files that actually reached the model — never the plan's raw wish-list,
    // which may still contain hallucinated paths.
    page._attached = attached;
    const currentMetadata = snapshotPageMetadata(generationPage, attached);
    const hash = sha1([
      GENERATION_SCHEMA_VERSION,
      modelName,
      language,
      template,
      generationPage.title,
      generationPage.description || '',
      JSON.stringify((generationPage._children || []).map(child => [child.path, child.title])),
      ...attached.map(rel => JSON.stringify([rel, sha1(rawByPath[rel])])),
    ].join('|'));

    if (args.pages && !page.path.includes(args.pages)) {
      if (state.pages[page.path] === hash && fs.existsSync(outFile)) {
        page._publishedMetadata = currentMetadata;
        page._published = true;
        state.pageMetadata[page.path] = currentMetadata;
      }
      skipped++;
      return;
    }
    if (!args.force && state.pages[page.path] === hash && fs.existsSync(outFile)) {
      page._publishedMetadata = currentMetadata;
      page._published = true;
      state.pageMetadata[page.path] = currentMetadata;
      skipped++;
      console.log(`  SKIP  ${page.path} (unchanged)`);
      return;
    }
    if (page._landing) {
      const children = page._children || [];
      const missing = children.filter(child => !child._published);
      // Fail-soft: a landing renders whatever children DID publish. Only when
      // no child made it is there nothing to link, so the landing fails.
      if (missing.length && missing.length === children.length) {
        failed++;
        console.log(
          `  FAIL  ${page.path}: no published child page(s): `
          + missing.map(child => child.path).join(', ')
        );
        return;
      }
      if (missing.length) {
        console.log(
          `  note  ${page.path}: landing published without unpublished child(ren): `
          + missing.map(child => child.path).join(', ')
        );
      }
    }
    try {
      console.log(`  GEN   ${page.path} ...`);
      const promptOptions = {
        language,
        attached,
        lineCounts,
        template,
        profile: classifyPage(generationPage),
      };
      let rejected = '';
      let validation;
      let md = '';
      // Best-of across attempts: repair rounds can regress with small models,
      // so keep the least-broken structurally sound draft as a fail-soft
      // fallback instead of always judging the (possibly worst) last attempt.
      let best = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const messages = attempt === 0
          ? pageMessages(scan, generationPage, block, promptOptions)
          : repairPageMessages(
            scan,
            generationPage,
            block,
            rejected,
            validation.violations,
            promptOptions
          );
        const raw = await chat(
          profile,
          messages,
          { maxTokens: profile.maxTokens }
        );
        rejected = unwrapMarkdown(raw);
        const citationResult = sanitizeCitations(rejected, attached, lineCounts);
        md = citationResult.md;
        validation = validatePage(md, {
          page: generationPage,
          attached,
          citationResult,
        });
        if (citationResult.repaired) {
          console.log(
            `  note  ${page.path}: repaired ${citationResult.repaired} citation range(s)`
          );
        }
        if (citationResult.dropped) {
          console.log(
            `  note  ${page.path}: dropped ${citationResult.dropped} invalid citation item(s)`
          );
        }
        if (validation.ok) break;
        const codes = [...new Set(validation.violations.map(item => item.code))];
        // A draft qualifies for degraded publishing only when its skeleton is
        // sound: real content, single H1, balanced fences, and no refusal.
        const publishable = md.trim().length > 0
          && !codes.includes('refusal_text')
          && !codes.includes('h1_count')
          && !codes.includes('unbalanced_fence');
        if (publishable && (!best || validation.violations.length < best.violations.length)) {
          best = { md, violations: validation.violations };
        }
        if (attempt < 2) {
          console.log(`  REPAIR ${page.path} attempt ${attempt + 1}/2 (${codes.join(',')})`);
        }
      }
      if (validation.ok) {
        atomicWrite(outFile, `${md.trim()}\n`);
        page._publishedMetadata = currentMetadata;
        page._published = true;
        state.pages[page.path] = hash;
        state.pageMetadata[page.path] = currentMetadata;
        saveState();
        ok++;
        console.log(`  OK    ${page.path} (${md.length} chars, ${attached.length} source files)`);
      } else if (best) {
        // Fail-soft: an imperfect page beats a hole in the wiki. Publish the
        // best draft, flag it, and leave it hash-less so the next run retries.
        const codes = [...new Set(best.violations.map(item => item.code))].join(',');
        const degradedMetadata = { ...currentMetadata, quality: 'degraded' };
        atomicWrite(outFile, `${best.md.trim()}\n`);
        page._publishedMetadata = degradedMetadata;
        page._published = true;
        delete state.pages[page.path];
        state.pageMetadata[page.path] = degradedMetadata;
        saveState();
        degraded++;
        console.log(`  WARN  ${page.path}: published degraded after 3 attempts (${codes})`);
      } else {
        const codes = [...new Set(validation.violations.map(item => item.code))].join(',');
        throw new Error(`quality validation failed after 3 attempts (${codes})`);
      }
    } catch (err) {
      page._publishedMetadata = fs.existsSync(outFile) ? existingMetadata : null;
      page._published = !!page._publishedMetadata;
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
  // Skipped entirely when this run had page failures: a failed replacement
  // page must never cause deletion of its still-good predecessor.
  if (failed > 0) {
    console.log(`  stale cleanup skipped (${failed} page failure${failed === 1 ? '' : 's'})`);
  } else {
    const previouslyManagedPaths = new Set([
      ...Object.keys(state.pages),
      ...Object.keys(state.pageMetadata),
    ]);
    for (const rel of previouslyManagedPaths) {
      if (!currentPaths.has(rel)) {
        const managed = safeManagedPath(outDir, rel);
        if (managed && fs.existsSync(managed.full)) {
          const stat = fs.lstatSync(managed.full);
          if (stat.isFile() || stat.isSymbolicLink()) {
            fs.unlinkSync(managed.full);
            console.log(`  removed stale: ${managed.rel}`);
          }
        }
        delete state.pages[rel];
        delete state.pageMetadata[rel];
      }
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
  state.generationSchemaVersion = GENERATION_SCHEMA_VERSION;
  state.generatedAt = new Date().toISOString();
  saveState();

  // --- Catalog + navigable index (meta layer) ---
  const publishedMetadata = pages
    .map(page => page._publishedMetadata)
    .filter(Boolean);
  const publishedByPath = new Map(
    publishedMetadata.map(metadata => [metadata.path, metadata])
  );
  const parentByChild = new Map();
  for (const metadata of publishedMetadata) {
    if (!metadata.isLanding) continue;
    for (const childPath of metadata.child_paths) {
      if (publishedByPath.has(childPath) && !parentByChild.has(childPath)) {
        parentByChild.set(childPath, metadata.path);
      }
    }
  }
  const catalog = {
    repo: scan.name,
    model: modelName,
    language,
    generatedAt: state.generatedAt,
    pages: publishedMetadata.map(metadata => {
      return {
        path: metadata.path,
        title: metadata.title,
        description: metadata.description,
        // These files belong to the exact last successfully published page,
        // rather than to a newer plan whose generation may have failed.
        dependent_files: metadata.dependent_files,
        parent: parentByChild.get(metadata.path) || null,
        isLanding: metadata.isLanding,
        quality: metadata.quality || 'ok',
      };
    }),
  };
  fs.mkdirSync(metaDir, { recursive: true });
  atomicWrite(
    path.join(metaDir, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`
  );

  // Human-navigable index that works in any markdown viewer.
  const idx = [`# ${scan.name} — Wiki`, ''];
  const indexPages = publishedMetadata.map(metadata => ({
    ...metadata,
    _landing: metadata.isLanding,
  }));
  const publishedByDir = groupPages(indexPages);
  for (const p of indexPages.filter(pg => !dirOf(pg.path))) {
    idx.push(`- [${p.title}](${p.path})`);
  }
  for (const d of [...publishedByDir.keys()].filter(Boolean).sort()) {
    const group = publishedByDir.get(d);
    const landing = group.find(p => p._landing);
    const children = group.filter(p => !p._landing);
    if (landing) {
      idx.push(`- [${landing.title}](${landing.path})`);
      for (const c of children.filter(child => parentByChild.get(child.path) === landing.path)) {
        idx.push(`  - [${c.title}](${c.path})`);
      }
      for (const orphan of children.filter(child => !parentByChild.has(child.path))) {
        idx.push(`- [${orphan.title}](${orphan.path})`);
      }
    } else {
      idx.push(`- **${titleCase(d)}**`);
      for (const c of children) idx.push(`  - [${c.title}](${c.path})`);
    }
  }
  atomicWrite(path.join(outDir, 'index.md'), `${idx.join('\n')}\n`);
  console.log(`  catalog + index written -> ${path.relative(repoDir, metaDir)}`);

  // --- Optional knowledge-card layer (opt-in via --knowledge / config.knowledge) ---
  let knowledgeFailed = 0;
  if (args.knowledge || config.knowledge) {
    console.log('\nGenerating knowledge cards...');
    const modules = moduleMap(scan);
    const knowledgePlan = buildKnowledgePlan(
      scan,
      modules,
      KNOWLEDGE_CARDS,
      collectKnowledgeEvidence(repoDir, scan)
    );
    const managedContent = new Map();
    const yaml = [
      'schema_version: 1',
      `locale: ${language}`,
      `generated_at: "${state.generatedAt}"`,
      'nodes_managed: true',
      'modules:',
    ];
    for (const m of modules) {
      yaml.push(`    ${JSON.stringify(m.key)}:`);
      yaml.push(`        dir_name: ${JSON.stringify(m.dir)}`);
      yaml.push(`        title: ${JSON.stringify(m.title)}`);
      if (m.scope.length) {
        yaml.push('        scope:');
        for (const f of m.scope) yaml.push(`            - ${JSON.stringify(f)}`);
      } else {
        yaml.push('        scope: []');
      }
      if (m.children.length) {
        yaml.push('        children:');
        for (const c of m.children) yaml.push(`            - ${JSON.stringify(c)}`);
      } else {
        yaml.push('        children: []');
      }
    }
    managedContent.set('_index.yaml', `${yaml.join('\n')}\n`);

    for (const m of modules) {
      const mod = [
        'schema_version: 1',
        `module_path: ${JSON.stringify(m.path)}`,
        `title: ${JSON.stringify(m.title)}`,
      ];
      if (m.scope.length) {
        mod.push('scope:', ...m.scope.map(f => `    - ${JSON.stringify(f)}`));
      } else {
        mod.push('scope: []');
      }
      managedContent.set(`${m.dir}/_module.yaml`, `${mod.join('\n')}\n`);
    }

    let knowledgeGenerated = 0;
    for (const card of knowledgePlan.cards) {
      try {
        const { block, attached } = buildFilesBlock(
          repoDir,
          { files: card.source_files },
          scan,
          contextChars
        );
        const groundedCard = { ...card, source_files: attached };
        const raw = await chat(
          profile,
          knowledgeMessages(scan, groundedCard, block, { language }),
          { maxTokens: profile.maxTokens }
        );
        const body = unwrapMarkdown(raw);
        const validation = validateKnowledgeContent(body);
        if (!validation.ok) {
          throw new Error(
            validation.violations.map(item => item.code).join(',')
          );
        }
        managedContent.set(
          card.relativePath,
          `${renderFrontmatter(groundedCard)}\n${body.trim()}\n`
        );
        knowledgeGenerated++;
      } catch (err) {
        knowledgeFailed++;
        console.log(`  FAIL  ${card.relativePath}: ${err.message.split('\n')[0]}`);
      }
    }

    if (knowledgeFailed === 0) {
      const previousManifest = loadManifest(knowledgeBase);
      const publishEntries = [...managedContent].map(([relative, content]) => {
        const managed = safeManagedPath(knowledgeBase, relative);
        if (!managed) throw new Error(`unsafe managed knowledge path: ${relative}`);
        return [managed.full, content];
      });
      for (const [file, content] of publishEntries) {
        atomicWrite(file, content);
      }
      const nextFiles = [...managedContent.keys()];
      const removed = cleanupManagedKnowledge(
        knowledgeBase,
        previousManifest.files,
        nextFiles
      );
      writeManifest(knowledgeBase, nextFiles);
      console.log(
        `  knowledge: ${knowledgeGenerated} cards written, `
        + `${knowledgePlan.duplicates} duplicates skipped, ${removed.length} stale removed `
        + `-> ${path.relative(repoDir, knowledgeBase)}`
      );
    } else {
      console.log(
        `  knowledge: ${knowledgeFailed} failed; previous managed output preserved`
      );
    }
  }

  console.log(
    `\nDone: ${ok} generated, ${degraded} degraded, ${skipped} skipped, `
    + `${failed} page failures, ${knowledgeFailed} knowledge failures -> ${outDir}`
  );
  console.log(`Tip: export to PDF with  node ${path.join(__dirname, 'export.js')} ${outDir} ${path.join(repoDir, 'wiki-pdf')}`);
  process.exit(failed + knowledgeFailed > 0 ? 1 : 0);
})().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
