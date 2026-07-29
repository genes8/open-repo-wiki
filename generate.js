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
 * pages are skipped on re-runs; stale-page deletion requires an explicit flag.
 *
 * Usage: node generate.js [repoDir] [options]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scanRepo } = require('./lib/scan');
const { chatDetailed, resolveApiKey } = require('./lib/providers');
const {
  planMessages,
  repairPlanMessages,
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
  previousPlanFromState,
  validatePlanQuality,
} = require('./lib/plan-quality');
const { createRunDiagnostics } = require('./lib/run-diagnostics');
const { createRunTransaction } = require('./lib/run-transaction');
const { deriveOutputLayout } = require('./lib/output-layout');
const {
  buildKnowledgePlan,
  cleanupManagedKnowledge,
  loadManifest,
  renderFrontmatter,
  safeManagedPath,
  validateKnowledgeContent,
  writeManifest,
} = require('./lib/knowledge');

const GENERATION_SCHEMA_VERSION = 3;

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
                        content-language dir, mirroring Qoder's repowiki layout).
                        Flat custom --out paths keep support data in
                        <out>.local-wiki instead.
      --force           regenerate everything, ignore the incremental cache
      --dry-run         print the wiki plan and exit without writing pages
      --prune           delete managed pages omitted by a successful,
                        non-regressive full plan
      --accept-plan-shrink
                        accept a regressive plan and delete omitted managed pages
                        (cannot be combined with --pages)
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
    else if (a === '--prune') args.prune = true;
    else if (a === '--accept-plan-shrink') args.acceptPlanShrink = true;
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

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function planSnapshot(pages) {
  return {
    pages: (pages || []).map(page => ({
      path: page.path,
      title: page.title,
      description: page.description || '',
      files: [...(page.files || [])],
      isLanding: !!page._landing,
      child_paths: (page._children || []).map(child => child.path),
    })),
  };
}

function pruneEmptyDirectories(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    pruneEmptyDirectories(full);
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  }
}

function completionWasTruncated(finishReason) {
  return /^(?:length|max_tokens|token_limit)$/i.test(String(finishReason || ''));
}

let activeTransaction = null;
let activeDiagnostics = null;
let publicationCommitted = false;

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (args.pages && (args.prune || args.acceptPlanShrink)) {
    console.error('--pages cannot be combined with --prune or --accept-plan-shrink');
    process.exit(1);
  }

  const requestedRepoDir = path.resolve(args._[0] || process.cwd());
  if (!fs.existsSync(requestedRepoDir) || !fs.statSync(requestedRepoDir).isDirectory()) {
    console.error(`Repository directory not found: ${requestedRepoDir}`);
    process.exit(1);
  }
  const repoDir = fs.realpathSync(requestedRepoDir);

  const { config, configPath } = loadConfig(args, repoDir);
  if (args.listModels) { listModels(config); process.exit(0); }

  const { name: modelName, profile } = pickProfile(config, args);
  const requestedOutDir = path.resolve(
    args.out || path.join(repoDir, '.local-wiki/en/content')
  );
  const outWithinRequestedRepo = path.relative(requestedRepoDir, requestedOutDir);
  const liveOutDir = args.out
    && outWithinRequestedRepo !== '..'
    && !outWithinRequestedRepo.startsWith(`..${path.sep}`)
    && !path.isAbsolute(outWithinRequestedRepo)
    ? path.resolve(repoDir, outWithinRequestedRepo)
    : requestedOutDir;
  const liveStatePath = path.join(liveOutDir, '.state.json');
  const maxPages = config.maxPages || 20;
  const language = config.language || 'en';
  const contextChars = profile.contextChars || 24000;
  const template = args.template || config.template || 'standard';
  const outputLayout = deriveOutputLayout(liveOutDir, language);
  const {
    localWikiRoot,
    metaDir: liveMetaDir,
    knowledgeBase: liveKnowledgeBase,
    runsDir,
  } = outputLayout;
  const knowledgeRequested = !!(args.knowledge || config.knowledge);
  const deleteStale = !!(args.prune || args.acceptPlanShrink);

  console.log(`Repo:   ${repoDir}`);
  console.log(`Model:  ${modelName} (${profile.provider}: ${profile.model || profile.modelPath})`);
  console.log(`Config: ${configPath}`);
  console.log(`Out:    ${liveOutDir}\n`);

  console.log('Scanning repository...');
  const scan = scanRepo(repoDir);
  if (scan.files.length === 0) {
    console.error('No readable source files found — nothing to document.');
    process.exit(1);
  }
  console.log(`  ${scan.files.length} files considered\n`);

  let state = { model: modelName, pages: {}, pageMetadata: {} };
  try {
    state = JSON.parse(fs.readFileSync(liveStatePath, 'utf8'));
  } catch {
    // First run or an unreadable legacy state; catalog fallback remains available.
  }
  if (!state.pages || typeof state.pages !== 'object') state.pages = {};
  if (!state.pageMetadata || typeof state.pageMetadata !== 'object') {
    state.pageMetadata = {};
  }
  const priorMetadataByPath = metadataFromCatalog(liveMetaDir);
  for (const [pagePath, value] of Object.entries(state.pageMetadata)) {
    const metadata = normalizePublishedMetadata(value, pagePath);
    if (metadata) priorMetadataByPath.set(pagePath, metadata);
  }
  state.pageMetadata = Object.fromEntries(priorMetadataByPath);
  const previousPages = previousPlanFromState(state, {
    pages: [...priorMetadataByPath.values()],
  });

  const runId = newRunId();
  const diagnostics = createRunDiagnostics(runsDir, {
    runId,
    repo: scan.name,
    provider: profile.provider,
    model: profile.model || profile.modelPath || modelName,
    flags: {
      prune: !!args.prune,
      acceptPlanShrink: !!args.acceptPlanShrink,
      force: !!args.force,
      dryRun: !!args.dryRun,
      pages: args.pages || null,
      knowledge: knowledgeRequested,
    },
  });
  activeDiagnostics = diagnostics;

  // --- Stage 1: wiki structure plan ---
  console.log('Planning wiki structure...');
  let normalized;
  let rejectedPlan = '';
  let planViolations = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const messages = attempt === 1
      ? planMessages(scan, { maxPages })
      : repairPlanMessages(
        scan,
        previousPages,
        rejectedPlan,
        planViolations,
        { maxPages }
      );
    let completion = null;
    let candidate = null;
    planViolations = [];
    try {
      completion = await chatDetailed(
        profile,
        messages,
        {
          maxTokens: profile.maxTokens,
          retries: profile.retries,
        }
      );
      rejectedPlan = completion.content;
      const parsed = extractJson(rejectedPlan);
      candidate = normalizePlan(parsed.pages, scan, { maxPages });
      if (completionWasTruncated(completion.finishReason)) {
        planViolations.push({
          code: 'plan_completion_truncated',
          message: `provider reported a truncated plan (${completion.finishReason})`,
        });
      }
      planViolations.push(...validatePlanQuality(
        candidate.pages,
        previousPages,
        { acceptPlanShrink: !!args.acceptPlanShrink }
      ).violations);
    } catch (error) {
      planViolations.push({
        code: completion ? 'plan_invalid' : 'plan_provider_error',
        message: error.message,
      });
    }
    diagnostics.recordPlanAttempt(attempt, rejectedPlan, {
      provider: profile.provider,
      model: profile.model || profile.modelPath || modelName,
      finishReason: completion && completion.finishReason,
      usage: completion && completion.usage,
      normalizedPlan: candidate ? planSnapshot(candidate.pages) : null,
      violations: planViolations,
      accepted: !!candidate && planViolations.length === 0,
    });
    if (candidate && planViolations.length === 0) {
      normalized = candidate;
      break;
    }
    const codes = planViolations.map(item => item.code).join(',');
    if (attempt < 3) console.log(`  REPAIR plan attempt ${attempt}/2 (${codes})`);
  }
  if (!normalized) {
    diagnostics.finish('aborted', {
      planFailures: 1,
      pageFailures: 0,
      knowledgeFailures: 0,
    });
    console.error(
      `Plan failed after 3 attempts (${planViolations.map(item => item.code).join(',')})`
    );
    process.exit(1);
  }
  const pages = normalized.pages;
  diagnostics.acceptPlan(planSnapshot(pages));
  console.log(`  ${pages.length} pages planned:`);
  for (const p of pages) console.log(`    - ${p.path}  (${p.title})`);

  if (args.dryRun) {
    diagnostics.finish('dry-run', {
      planFailures: 0,
      pageFailures: 0,
      knowledgeFailures: 0,
      plannedPages: pages.length,
    });
    console.log('\nDry run — no pages written.');
    process.exit(0);
  }

  // --- Stage 2: generate pages (incremental, optionally parallel) ---
  const transactionTargets = [
    { name: 'content', live: liveOutDir },
    { name: 'meta', live: liveMetaDir },
    ...(knowledgeRequested
      ? [{ name: 'knowledge', live: liveKnowledgeBase }]
      : []),
  ];
  const transaction = createRunTransaction(transactionTargets, runId);
  activeTransaction = transaction;
  transaction.prepare();
  const outDir = transaction.stagePath('content');
  const metaDir = transaction.stagePath('meta');
  const knowledgeBase = knowledgeRequested
    ? transaction.stagePath('knowledge')
    : liveKnowledgeBase;
  const statePath = path.join(outDir, '.state.json');
  const saveState = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  const concurrency = Math.max(1, parseInt(args.concurrency, 10)
    || profile.concurrency || config.concurrency || 1);
  if (concurrency > 1) console.log(`  concurrency: ${concurrency}`);

  let ok = 0, skipped = 0, failed = 0;
  const currentPaths = new Set(pages.map(p => p.path));

  const mainPages = pages.filter(p => !p._landing);
  const landingPages = pages.filter(p => p._landing);

  const processPage = async (page) => {
    const managedOutput = safeManagedPath(outDir, page.path);
    if (!managedOutput) {
      page._publishedMetadata = null;
      page._published = false;
      failed++;
      console.log(`  FAIL  ${page.path}: unsafe staged page path`);
      return;
    }
    const outFile = managedOutput.full;
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
      visibleByPath,
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
      if (fs.existsSync(outFile) && existingMetadata) {
        page._publishedMetadata = existingMetadata;
        page._published = true;
        state.pageMetadata[page.path] = existingMetadata;
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
      const missing = (page._children || []).filter(child => !child._published);
      if (missing.length) {
        failed++;
        console.log(
          `  FAIL  ${page.path}: unpublished child page(s): `
          + missing.map(child => child.path).join(', ')
        );
        return;
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
        let completion;
        try {
          completion = await chatDetailed(
            profile,
            messages,
            {
              maxTokens: profile.maxTokens,
              retries: profile.retries,
            }
          );
        } catch (error) {
          diagnostics.recordPageAttempt(page.path, attempt + 1, '', {
            provider: profile.provider,
            model: profile.model || profile.modelPath || modelName,
            finishReason: null,
            usage: null,
            citationViolations: [],
            violations: [{
              code: 'page_provider_error',
              message: error.message,
            }],
            stats: null,
            accepted: false,
          });
          throw error;
        }
        rejected = unwrapMarkdown(completion.content);
        const citationResult = sanitizeCitations(rejected, attached, lineCounts);
        md = citationResult.md;
        validation = validatePage(md, {
          page: generationPage,
          attached,
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
        if (citationResult.dropped) {
          console.log(
            `  note  ${page.path}: dropped ${citationResult.dropped} invalid citation item(s)`
          );
        }
        if (validation.ok) break;
        const codes = [...new Set(validation.violations.map(item => item.code))].join(',');
        if (attempt < 2) {
          console.log(`  REPAIR ${page.path} attempt ${attempt + 1}/2 (${codes})`);
        } else {
          throw new Error(`quality validation failed after 3 attempts (${codes})`);
        }
      }
      atomicWrite(outFile, `${md.trim()}\n`);
      page._publishedMetadata = currentMetadata;
      page._published = true;
      state.pages[page.path] = hash;
      state.pageMetadata[page.path] = currentMetadata;
      ok++;
      console.log(`  OK    ${page.path} (${md.length} chars, ${attached.length} source files)`);
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

  if (failed > 0) {
    transaction.abort();
    activeTransaction = null;
    diagnostics.finish('aborted', {
      planFailures: 0,
      pageFailures: failed,
      knowledgeFailures: 0,
    });
    console.log(
      `\nAborted: ${ok} staged, ${skipped} skipped, `
      + `${failed} page failures; live wiki unchanged`
    );
    process.exit(1);
  }

  // --- Remove stale pages (dropped from the plan since the last run) ---
  const previouslyManagedPaths = new Set([
    ...Object.keys(state.pages),
    ...Object.keys(state.pageMetadata),
  ]);
  for (const rel of previouslyManagedPaths) {
    if (deleteStale && !currentPaths.has(rel)) {
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
  if (deleteStale) pruneEmptyDirectories(outDir);

  state.model = modelName;
  state.generationSchemaVersion = GENERATION_SCHEMA_VERSION;
  state.generatedAt = new Date().toISOString();
  state.lastSuccessfulPlan = planSnapshot(pages).pages;
  state.lastRunId = runId;

  // --- Catalog + navigable index (meta layer) ---
  const publishedMetadataByPath = new Map(pages
    .map(page => page._publishedMetadata)
    .filter(Boolean)
    .map(metadata => [metadata.path, metadata]));
  if (!deleteStale) {
    for (const [pagePath, metadata] of priorMetadataByPath) {
      if (publishedMetadataByPath.has(pagePath) || currentPaths.has(pagePath)) continue;
      const managed = safeManagedPath(outDir, pagePath);
      if (!managed || !fs.existsSync(managed.full)) continue;
      const stat = fs.lstatSync(managed.full);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      publishedMetadataByPath.set(pagePath, metadata);
    }
  }
  const publishedMetadata = [...publishedMetadataByPath.values()];
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
  console.log(`  catalog + index staged -> ${path.relative(repoDir, liveMetaDir)}`);
  saveState();

  // --- Optional knowledge-card layer (opt-in via --knowledge / config.knowledge) ---
  let knowledgeFailed = 0;
  if (knowledgeRequested) {
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
      let recorded = false;
      let draft = '';
      try {
        const { block, attached } = buildFilesBlock(
          repoDir,
          { files: card.source_files },
          scan,
          contextChars
        );
        const groundedCard = { ...card, source_files: attached };
        const completion = await chatDetailed(
          profile,
          knowledgeMessages(scan, groundedCard, block, { language }),
          {
            maxTokens: profile.maxTokens,
            retries: profile.retries,
          }
        );
        const body = unwrapMarkdown(completion.content);
        draft = body;
        const validation = validateKnowledgeContent(body);
        if (completionWasTruncated(completion.finishReason)) {
          validation.violations.push({
            code: 'knowledge_completion_truncated',
            message: `provider reported a truncated knowledge card (${completion.finishReason})`,
          });
          validation.ok = false;
        }
        const diagnosticPath = card.relativePath.replace(/\.md$/i, '');
        diagnostics.writeText(
          `knowledge/${diagnosticPath}/attempt-1.md`,
          body
        );
        diagnostics.writeJson(
          `knowledge/${diagnosticPath}/attempt-1.json`,
          {
            provider: profile.provider,
            model: profile.model || profile.modelPath || modelName,
            finishReason: completion.finishReason,
            usage: completion.usage,
            violations: validation.violations,
            accepted: validation.ok,
          }
        );
        recorded = true;
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
        if (!recorded) {
          const diagnosticPath = card.relativePath.replace(/\.md$/i, '');
          diagnostics.writeText(
            `knowledge/${diagnosticPath}/attempt-1.md`,
            draft
          );
          diagnostics.writeJson(
            `knowledge/${diagnosticPath}/attempt-1.json`,
            {
              provider: profile.provider,
              model: profile.model || profile.modelPath || modelName,
              finishReason: null,
              usage: null,
              violations: [{
                code: 'knowledge_generation_error',
                message: err.message,
              }],
              accepted: false,
            }
          );
        }
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
        + `-> ${path.relative(repoDir, liveKnowledgeBase)}`
      );
    } else {
      console.log(
        `  knowledge: ${knowledgeFailed} failed; staged run will be discarded`
      );
    }
  }

  if (knowledgeFailed > 0) {
    transaction.abort();
    activeTransaction = null;
    diagnostics.finish('aborted', {
      planFailures: 0,
      pageFailures: 0,
      knowledgeFailures: knowledgeFailed,
    });
    console.log(
      `\nAborted: ${ok} staged, ${skipped} skipped, `
      + `${knowledgeFailed} knowledge failures; live wiki unchanged`
    );
    process.exit(1);
  }

  const publicationResult = transaction.commit();
  publicationCommitted = true;
  activeTransaction = null;
  for (const warning of publicationResult.cleanupWarnings) {
    console.warn(`  WARN  backup cleanup (${warning.target}): ${warning.message}`);
  }
  diagnostics.finish('committed', {
    planFailures: 0,
    pageFailures: 0,
    knowledgeFailures: 0,
    publishedPages: publishedMetadata.length,
    publicationPhase: 'swapped',
    cleanupWarnings: publicationResult.cleanupWarnings,
  });
  activeDiagnostics = null;

  console.log(
    `\nDone: ${ok} generated, ${skipped} skipped, `
    + `${failed} page failures, ${knowledgeFailed} knowledge failures -> ${liveOutDir}`
  );
  console.log(`Tip: export to PDF with  node ${path.join(__dirname, 'export.js')} ${liveOutDir} ${path.join(repoDir, 'wiki-pdf')}`);
  process.exit(0);
})().catch(err => {
  let rollbackFailure = err.rollbackError || null;
  if (activeTransaction) {
    try {
      activeTransaction.abort();
    } catch (rollbackError) {
      rollbackFailure ||= rollbackError;
    }
  }
  if (activeDiagnostics && !publicationCommitted) {
    try {
      activeDiagnostics.finish('aborted', {
        fatalError: err.message,
        publicationPhase: rollbackFailure ? 'rollback_failed' : 'aborted',
        ...(rollbackFailure ? { rollbackError: rollbackFailure.message } : {}),
      });
    } catch (diagnosticError) {
      console.error(`Diagnostics failed: ${diagnosticError.message}`);
    }
  }
  if (rollbackFailure) console.error(`Rollback failed: ${rollbackFailure.message}`);
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
