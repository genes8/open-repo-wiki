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
  let normalized;
  try {
    normalized = normalizePlan(plan.pages, scan, { maxPages });
  } catch (err) {
    console.error(`Plan failed validation: ${err.message}`);
    process.exit(1);
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

  const mainPages = pages.filter(p => !p._landing);
  const landingPages = pages.filter(p => p._landing);

  const processPage = async (page) => {
    const outFile = path.join(outDir, page.path);
    page._published = fs.existsSync(outFile);
    if (args.pages && !page.path.includes(args.pages)) { skipped++; return; }
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
    const {
      block,
      attached,
      lineCounts,
      rawByPath,
    } = buildFilesBlock(repoDir, page, scan, contextChars);
    // Record the validated (real, attached) subset so the catalog cites only
    // files that actually reached the model — never the plan's raw wish-list,
    // which may still contain hallucinated paths.
    page._attached = attached;
    const hash = sha1([
      GENERATION_SCHEMA_VERSION,
      modelName,
      language,
      template,
      page.title,
      page.description || '',
      JSON.stringify((page._children || []).map(child => [child.path, child.title])),
      ...attached.map(rel => JSON.stringify([rel, sha1(rawByPath[rel])])),
    ].join('|'));

    if (!args.force && state.pages[page.path] === hash && fs.existsSync(outFile)) {
      page._published = true;
      skipped++;
      console.log(`  SKIP  ${page.path} (unchanged)`);
      return;
    }
    try {
      console.log(`  GEN   ${page.path} ...`);
      const promptOptions = {
        language,
        attached,
        lineCounts,
        template,
        profile: classifyPage(page),
      };
      let rejected = '';
      let validation;
      let md = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const messages = attempt === 0
          ? pageMessages(scan, page, block, promptOptions)
          : repairPageMessages(
            scan,
            page,
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
        validation = validatePage(md, { page, attached, citationResult });
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
      page._published = true;
      state.pages[page.path] = hash;
      saveState();
      ok++;
      console.log(`  OK    ${page.path} (${md.length} chars, ${attached.length} source files)`);
    } catch (err) {
      page._published = fs.existsSync(outFile);
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
  state.generationSchemaVersion = GENERATION_SCHEMA_VERSION;
  state.generatedAt = new Date().toISOString();
  saveState();

  // --- Catalog + navigable index (meta layer) ---
  const publishedPages = pages.filter(page => page._published);
  const publishedPaths = new Set(publishedPages.map(page => page.path));
  const catalog = {
    repo: scan.name,
    model: modelName,
    language,
    generatedAt: state.generatedAt,
    pages: publishedPages.map(p => {
      return {
        path: p.path,
        title: p.title,
        description: p._desc0 || p.description || '',
        // Real files that reached the model, not the plan's raw list (which may
        // still name paths that don't exist in the repo).
        dependent_files: p._attached || (p.files || []).filter(f => scan.fileSet.has(f)),
        parent: publishedPaths.has(normalized.parentByPath.get(p.path))
          ? normalized.parentByPath.get(p.path)
          : null,
        isLanding: !!p._landing,
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
  const publishedByDir = groupPages(publishedPages);
  for (const p of publishedPages.filter(pg => !dirOf(pg.path))) {
    idx.push(`- [${p.title}](${p.path})`);
  }
  for (const d of [...publishedByDir.keys()].filter(Boolean).sort()) {
    const group = publishedByDir.get(d);
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
    `\nDone: ${ok} generated, ${skipped} skipped, `
    + `${failed} page failures, ${knowledgeFailed} knowledge failures -> ${outDir}`
  );
  console.log(`Tip: export to PDF with  node ${path.join(__dirname, 'export.js')} ${outDir} ${path.join(repoDir, 'wiki-pdf')}`);
  process.exit(failed + knowledgeFailed > 0 ? 1 : 0);
})().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
