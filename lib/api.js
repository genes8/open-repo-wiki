'use strict';
/**
 * Programmatic wiki engine API. Everything the CLI does is available here as
 * Promise-based functions emitting typed events (see lib/events.js). The CLI
 * and the VSCode extension's engine-entry both call these.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scanRepo } = require('./scan');
const { loadWikiPlan } = require('./plan-file');
const { applyScope } = require('./scope-filter');
const { chatDetailed, resolveApiKey } = require('./providers');
const {
  planMessages,
  repairPlanMessages,
  pageMessages,
  repairPageMessages,
  knowledgeMessages,
  KNOWLEDGE_CARDS,
  extractJson,
} = require('./prompts');
const { moduleMap, titleCase } = require('./modules');
const { sanitizeCitations } = require('./citations');
const { normalizePlan, dirOf, groupPages } = require('./plan');
const { buildFilesBlock } = require('./sources');
const { classifyPage, validatePage } = require('./quality');
const {
  previousPlanFromState,
  validatePlanQuality,
} = require('./plan-quality');
const { createRunDiagnostics } = require('./run-diagnostics');
const { createRunTransaction } = require('./run-transaction');
const { deriveOutputLayout } = require('./output-layout');
const {
  buildKnowledgePlan,
  cleanupManagedKnowledge,
  loadManifest,
  renderFrontmatter,
  safeManagedPath,
  validateKnowledgeContent,
  writeManifest,
} = require('./knowledge');
const { createEventBus } = require('./events');

const GENERATION_SCHEMA_VERSION = 3;

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Normalize CLI-ish options into one place. Accepts both flag names from the
// CLI and camelCase from programmatic callers.
function normalizeOptions(options = {}) {
  return {
    model: options.model || null,
    out: options.out || null,
    configPath: options.config || options.configPath || null,
    pages: options.pages || null,
    concurrency: options.concurrency || null,
    template: options.template || null,
    knowledge: !!options.knowledge,
    force: !!options.force,
    dryRun: !!options.dryRun,
    prune: !!options.prune,
    acceptPlanShrink: !!options.acceptPlanShrink,
  };
}

// Zero-dependency .env loader. Reads KEY=VALUE lines from <repoDir>/.env then
// <appDir>/.env into process.env WITHOUT overriding vars already set in the real
// environment (real env always wins). Keeps secrets out of the committed config:
// config.json only references env var NAMES ("env:ZHIPU_API_KEY"), the values
// live in an untracked .env file. Supports optional `export ` prefix, # comments,
// and single/double quoted values.
function loadDotenv(repoDir, onEvent = null) {
  const files = [path.join(repoDir, '.env'), path.join(__dirname, '..', '.env')];
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
  if (loaded && onEvent) onEvent('env_loaded', { count: loaded });
}

function loadConfig(args, repoDir) {
  const candidates = [
    args.config || args.configPath,
    path.join(repoDir, 'repo-wiki.config.json'),
    path.join(__dirname, '..', 'config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return { config: JSON.parse(fs.readFileSync(p, 'utf8')), configPath: p };
      } catch (err) {
        throw new ApiError('bad_config', `Invalid JSON in ${p}: ${err.message}`);
      }
    }
  }
  throw new ApiError('bad_config', 'No config file found.');
}

function pickProfile(config, args) {
  const name = args.model || process.env.REPO_WIKI_MODEL || config.default;
  const profile = config.models && config.models[name];
  if (!profile) {
    throw new ApiError(
      'unknown_model',
      `Model profile '${name}' not found. Available: ${Object.keys(config.models || {}).join(', ')}`
    );
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
    outputHash: typeof value.outputHash === 'string' ? value.outputHash : null,
    curated: value.curated === true,
    externallyModified: value.externallyModified === true,
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
    outputHash: null,
    curated: page._curated === true,
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

async function generateWiki(repoDir, options = {}, onEvent = () => {}) {
  const opts = normalizeOptions(options);
  const { bus, emit } = createEventBus();
  bus.on('event', onEvent);

  let activeTransaction = null;
  let activeDiagnostics = null;
  let publicationCommitted = false;

  try {
    if (opts.pages && (opts.prune || opts.acceptPlanShrink)) {
      throw new ApiError('bad_args', '--pages cannot be combined with --prune or --accept-plan-shrink');
    }

    const requestedRepoDir = path.resolve(repoDir);
    if (!fs.existsSync(requestedRepoDir) || !fs.statSync(requestedRepoDir).isDirectory()) {
      throw new ApiError('bad_args', `Repository directory not found: ${requestedRepoDir}`);
    }
    repoDir = fs.realpathSync(requestedRepoDir);
    // Populate process.env from an untracked .env before any provider key is
    // resolved, so config.json can reference secrets by name ("env:ZHIPU_API_KEY")
    // without committing their values.
    loadDotenv(repoDir, emit);

    const { config, configPath } = loadConfig(options, repoDir);

    const { name: modelName, profile } = pickProfile(config, options);
    const requestedOutDir = path.resolve(
      opts.out || path.join(repoDir, '.local-wiki/en/content')
    );
    const outWithinRequestedRepo = path.relative(requestedRepoDir, requestedOutDir);
    const liveOutDir = opts.out
      && outWithinRequestedRepo !== '..'
      && !outWithinRequestedRepo.startsWith(`..${path.sep}`)
      && !path.isAbsolute(outWithinRequestedRepo)
      ? path.resolve(repoDir, outWithinRequestedRepo)
      : requestedOutDir;
    const liveStatePath = path.join(liveOutDir, '.state.json');
    const maxPages = config.maxPages || 20;
    const language = config.language || 'en';
    const contextChars = profile.contextChars || 24000;
    const template = opts.template || config.template || 'standard';
    const outputLayout = deriveOutputLayout(liveOutDir, language);
    const {
      localWikiRoot,
      metaDir: liveMetaDir,
      knowledgeBase: liveKnowledgeBase,
      runsDir,
    } = outputLayout;
    const knowledgeRequested = !!(opts.knowledge || config.knowledge);
    const deleteStale = !!(opts.prune || opts.acceptPlanShrink);

    emit('run_started', {
      repo: repoDir,
      model: modelName,
      provider: profile.provider,
      modelId: profile.model || profile.modelPath,
      configPath,
      outDir: liveOutDir,
    });

    emit('scan_started', {});
    const scan = scanRepo(repoDir);
    if (scan.files.length === 0) {
      throw new ApiError('no_files', 'No readable source files found — nothing to document.');
    }
    emit('scan_done', { files: scan.files.length });

    const wikiPlan = loadWikiPlan(repoDir);
    let effectiveScan = scan;
    if (wikiPlan) {
      try {
        effectiveScan = applyScope(scan, wikiPlan.scope);
      } catch (err) {
        if (err && err.code === 'empty_scope') {
          throw new ApiError('empty_scope', err.message);
        }
        throw err;
      }
      emit('plan_file_loaded', {
        file: fs.existsSync(path.join(repoDir, 'wiki_plan.yaml')) ? 'wiki_plan.yaml' : 'wiki_plan.json',
        documents: wikiPlan.repowiki.documents.length,
        scope: { include: wikiPlan.scope.include.length, exclude: wikiPlan.scope.exclude.length },
      });
    }

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
    // Empirical floor scaled to repository size, plus anchoring on previously
    // published pages, so one weak planner response cannot collapse the wiki or
    // churn stable paths/titles across runs. Prompt-level guidance only; the
    // deterministic regression gate (validatePlanQuality) stays authoritative.
    const minPages = Math.min(
      maxPages,
      Math.max(4, parseInt(config.minPages, 10) || Math.ceil(effectiveScan.files.length / 3))
    );
    const priorPages = previousPages.map(p => ({ path: p.path, title: p.title }));

    const runId = newRunId();
    const diagnostics = createRunDiagnostics(runsDir, {
      runId,
      repo: scan.name,
      provider: profile.provider,
      model: profile.model || profile.modelPath || modelName,
      flags: {
        prune: opts.prune,
        acceptPlanShrink: opts.acceptPlanShrink,
        force: opts.force,
        dryRun: opts.dryRun,
        pages: opts.pages,
        knowledge: knowledgeRequested,
      },
    });
    activeDiagnostics = diagnostics;

    // --- Stage 1: wiki structure plan ---
    emit('plan_started', {});
    let normalized;
    let rejectedPlan = '';
    let planViolations = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const messages = attempt === 1
        ? planMessages(effectiveScan, { maxPages, minPages, priorPages })
        : repairPlanMessages(
          effectiveScan,
          previousPages,
          rejectedPlan,
          planViolations,
          { maxPages, minPages, priorPages }
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
        candidate = normalizePlan(parsed.pages, effectiveScan, {
          maxPages,
          ensureCoverage: config.ensureCoverage !== false,
        });
        if (completionWasTruncated(completion.finishReason)) {
          planViolations.push({
            code: 'plan_completion_truncated',
            message: `provider reported a truncated plan (${completion.finishReason})`,
          });
        }
        planViolations.push(...validatePlanQuality(
          candidate.pages,
          previousPages,
          {
            acceptPlanShrink: opts.acceptPlanShrink,
            scan: config.ensureCoverage !== false ? effectiveScan : null,
          }
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
      if (attempt < 3) emit('plan_retry', { attempt, codes });
    }
    if (!normalized) {
      diagnostics.finish('aborted', {
        planFailures: 1,
        pageFailures: 0,
        knowledgeFailures: 0,
      });
      throw new ApiError(
        'plan_failed',
        `Plan failed after 3 attempts (${planViolations.map(item => item.code).join(',')})`
      );
    }
    const pages = normalized.pages;
    diagnostics.acceptPlan(planSnapshot(pages));
    emit('plan_ready', {
      pages: pages.map(p => ({ path: p.path, title: p.title })),
      coverage: (normalized.coverage && normalized.coverage.assigned.length) || 0,
    });

    if (opts.dryRun) {
      diagnostics.finish('dry-run', {
        planFailures: 0,
        pageFailures: 0,
        knowledgeFailures: 0,
        plannedPages: pages.length,
      });
      emit('dry_run', {});
      return { dryRun: true, pages: pages.length };
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

    const concurrency = Math.max(1, parseInt(opts.concurrency, 10)
      || profile.concurrency || config.concurrency || 1);
    if (concurrency > 1) emit('run_note', { message: `concurrency: ${concurrency}` });

    let ok = 0, skipped = 0, degraded = 0, failed = 0;
    const currentPaths = new Set(pages.map(p => p.path));

    const mainPages = pages.filter(p => !p._landing);
    const landingPages = pages.filter(p => p._landing);

    const processPage = async (page) => {
      const managedOutput = safeManagedPath(outDir, page.path);
      if (!managedOutput) {
        page._publishedMetadata = null;
        page._published = false;
        failed++;
        emit('page_fail', { path: page.path, message: 'unsafe staged page path' });
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
      } = buildFilesBlock(repoDir, generationPage, effectiveScan, contextChars);
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

      if (opts.pages && !page.path.includes(opts.pages)) {
        if (fs.existsSync(outFile) && existingMetadata) {
          page._publishedMetadata = existingMetadata;
          page._published = true;
          state.pageMetadata[page.path] = existingMetadata;
        }
        skipped++;
        return;
      }
      const liveContent = fs.existsSync(outFile) ? sha1(fs.readFileSync(outFile, 'utf8')) : null;
      const priorMeta = existingMetadata;
      const outputMismatch = !!(priorMeta && priorMeta.outputHash && liveContent
        && priorMeta.outputHash !== liveContent);
      const inputChanged = opts.force || state.pages[page.path] !== hash || !fs.existsSync(outFile);
      const protectedReason = priorMeta && (priorMeta.curated || outputMismatch)
        ? (priorMeta.curated ? 'curated' : 'externally-modified')
        : null;
      if (protectedReason && inputChanged && !opts.force) {
        page._publishedMetadata = {
          ...priorMeta,
          externallyModified: outputMismatch || priorMeta.externallyModified,
        };
        page._published = true;
        page._protected = true;
        state.pageMetadata[page.path] = page._publishedMetadata;
        skipped++;
        emit('page_done', { path: page.path, status: 'protected', reason: protectedReason });
        return;
      }
      if (!inputChanged) {
        if (outputMismatch) {
          emit('page_note', { path: page.path, message: 'externally modified by a human; left untouched' });
        }
        page._publishedMetadata = {
          ...currentMetadata,
          outputHash: priorMeta && priorMeta.outputHash ? priorMeta.outputHash : null,
          curated: !!(priorMeta && priorMeta.curated),
          externallyModified: outputMismatch,
        };
        page._published = true;
        state.pageMetadata[page.path] = page._publishedMetadata;
        skipped++;
        emit('page_done', { path: page.path, status: 'skipped', reason: 'unchanged' });
        return;
      }
      if (page._landing) {
        const children = page._children || [];
        const missing = children.filter(child => !child._published);
        // Fail-soft: a landing renders whatever children DID publish. Only when
        // no child made it is there nothing to link, so the landing fails.
        if (missing.length && missing.length === children.length) {
          failed++;
          emit('page_fail', {
            path: page.path,
            message: `no published child page(s): ${missing.map(child => child.path).join(', ')}`,
          });
          return;
        }
        if (missing.length) {
          emit('page_note', {
            path: page.path,
            message: `landing published without unpublished child(ren): ${missing.map(child => child.path).join(', ')}`,
          });
        }
      }
      try {
        emit('page_start', { path: page.path });
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
            ? pageMessages(effectiveScan, generationPage, block, promptOptions)
            : repairPageMessages(
              effectiveScan,
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
          if (citationResult.repaired) {
            emit('page_note', {
              path: page.path,
              message: `repaired ${citationResult.repaired} citation range(s)`,
            });
          }
          if (citationResult.dropped) {
            emit('page_note', {
              path: page.path,
              message: `dropped ${citationResult.dropped} invalid citation item(s)`,
            });
          }
          if (validation.ok) break;
          const codes = [...new Set(validation.violations.map(item => item.code))];
          // A draft qualifies for degraded publishing only when its skeleton is
          // sound AND its generation actually finished: real content, single H1,
          // balanced fences, no refusal, and not a truncated completion. A
          // truncated completion is incomplete output (the provider stopped mid
          // page), so — unlike a complete-but-thin draft — it aborts the run
          // rather than landing half-finished prose.
          const publishable = md.trim().length > 0
            && !codes.includes('refusal_text')
            && !codes.includes('h1_count')
            && !codes.includes('unbalanced_fence')
            && !codes.includes('completion_truncated');
          if (publishable && (!best || validation.violations.length < best.violations.length)) {
            best = { md, violations: validation.violations };
          }
          if (attempt < 2) {
            emit('page_retry', { path: page.path, attempt: attempt + 1, codes: codes.join(',') });
          }
        }
        if (validation.ok) {
          const content = `${md.trim()}\n`;
          atomicWrite(outFile, content);
          const publishedMetadata = { ...currentMetadata, outputHash: sha1(content) };
          page._publishedMetadata = publishedMetadata;
          page._published = true;
          state.pages[page.path] = hash;
          state.pageMetadata[page.path] = publishedMetadata;
          saveState();
          ok++;
          emit('page_done', { path: page.path, status: 'generated', chars: md.length, files: attached.length });
        } else if (best) {
          // Fail-soft: an imperfect page beats a hole in the wiki. Publish the
          // best draft, flag it, and leave it hash-less so the next run retries.
          const codes = [...new Set(best.violations.map(item => item.code))].join(',');
          const content = `${best.md.trim()}\n`;
          atomicWrite(outFile, content);
          const publishedMetadata = { ...currentMetadata, quality: 'degraded', outputHash: sha1(content) };
          page._publishedMetadata = publishedMetadata;
          page._published = true;
          delete state.pages[page.path];
          state.pageMetadata[page.path] = publishedMetadata;
          saveState();
          degraded++;
          emit('page_done', { path: page.path, status: 'degraded', codes });
        } else {
          const codes = [...new Set(validation.violations.map(item => item.code))].join(',');
          throw new Error(`quality validation failed after 3 attempts (${codes})`);
        }
      } catch (err) {
        page._publishedMetadata = fs.existsSync(outFile) ? existingMetadata : null;
        page._published = !!page._publishedMetadata;
        failed++;
        emit('page_fail', { path: page.path, message: err.message });
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
      emit('run_aborted', { ok, skipped, failed, subject: 'page' });
      throw new ApiError(
        'page_failures',
        `Aborted: ${ok} staged, ${skipped} skipped, ${failed} page failures; live wiki unchanged`
      );
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
            emit('stale_removed', { path: managed.rel });
          }
          delete state.pages[rel];
          delete state.pageMetadata[rel];
        }
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
          quality: metadata.quality || 'ok',
          protected: metadata.curated === true || metadata.externallyModified === true,
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
    emit('catalog_written', { metaDir: path.relative(repoDir, liveMetaDir) });
    saveState();

    // --- Optional knowledge-card layer (opt-in via --knowledge / config.knowledge) ---
    let knowledgeFailed = 0;
    if (knowledgeRequested) {
      emit('knowledge_started', {});
      const modules = moduleMap(effectiveScan);
      const knowledgePlan = buildKnowledgePlan(
        effectiveScan,
        modules,
        KNOWLEDGE_CARDS,
        collectKnowledgeEvidence(repoDir, effectiveScan)
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
            effectiveScan,
            contextChars
          );
          const groundedCard = { ...card, source_files: attached };
          const completion = await chatDetailed(
            profile,
            knowledgeMessages(effectiveScan, groundedCard, block, { language }),
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
          emit('knowledge_card_fail', { path: card.relativePath, message: err.message });
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
        emit('knowledge_done', {
          generated: knowledgeGenerated,
          duplicates: knowledgePlan.duplicates,
          removed: removed.length,
          dir: path.relative(repoDir, liveKnowledgeBase),
        });
      } else {
        emit('knowledge_failed_run', { failed: knowledgeFailed });
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
      emit('run_aborted', { ok, skipped, failed: knowledgeFailed, subject: 'knowledge' });
      throw new ApiError(
        'knowledge_failures',
        `Aborted: ${ok} staged, ${skipped} skipped, ${knowledgeFailed} knowledge failures; live wiki unchanged`
      );
    }

    const publicationResult = transaction.commit();
    publicationCommitted = true;
    activeTransaction = null;
    for (const warning of publicationResult.cleanupWarnings) {
      emit('cleanup_warning', { target: warning.target, message: warning.message });
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

    const stats = { generated: ok, degraded, skipped, failed, knowledgeFailed };
    const tip = `Tip: export to PDF with  node ${path.join(__dirname, '..', 'export.js')} ${liveOutDir} ${path.join(repoDir, 'wiki-pdf')}`;
    emit('run_finished', { stats, outDir: liveOutDir, tip });
    return { stats, catalog };
  } catch (err) {
    if (err instanceof ApiError) throw err;
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
          fatalError: String(err && err.message || err),
          publicationPhase: rollbackFailure ? 'rollback_failed' : 'aborted',
          ...(rollbackFailure ? { rollbackError: String(rollbackFailure && rollbackFailure.message || rollbackFailure) } : {}),
        });
      } catch (diagnosticError) {
        emit('run_note', { message: `Diagnostics failed: ${diagnosticError.message}` });
      }
    }
    if (rollbackFailure) emit('run_note', { message: `Rollback failed: ${String(rollbackFailure && rollbackFailure.message || rollbackFailure)}` });
    throw new ApiError('fatal', String(err && err.message || err));
  }
}

async function modifyWiki(repoDir, options = {}, onEvent = () => {}) {
  throw new ApiError('not_implemented', 'modifyWiki lands in Task 7');
}

module.exports = {
  generateWiki,
  modifyWiki,
  ApiError,
  loadConfig,
  loadDotenv,
  pickProfile,
  listModels,
  GENERATION_SCHEMA_VERSION,
};
