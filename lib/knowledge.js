'use strict';

const fs = require('fs');
const path = require('path');
const { titleCase } = require('./modules');
const { hasRefusalText } = require('./quality');

const TOPICS = Object.freeze([
  Object.freeze({
    key: 'configuration',
    kind: 'configuration_system',
    name: 'Configuration System',
    focus: 'How runtime and project configuration is defined, resolved, and consumed.',
    pathPattern: /(^|\/)(?:config(?:uration)?(?:[._/-]|$)|\.env(?:[._-]|$))/i,
    textPattern: /\bprocess\.env\b|\bos\.environ\b|\bgetenv\s*\(/i,
  }),
  Object.freeze({
    key: 'error_handling',
    kind: 'error_handling',
    name: 'Error Handling',
    focus: 'Observed error paths, propagation, recovery, retries, and failure reporting.',
    textPattern: /\btry\s*\{|\bcatch\s*\(|\bthrow\b|\braise\b/,
  }),
  Object.freeze({
    key: 'logging',
    kind: 'logging_system',
    name: 'Logging System',
    focus: 'Observed logging calls, levels, messages, and operational diagnostics.',
    textPattern: /\bconsole\.(?:log|warn|error|info|debug)\s*\(|\b(?:logger|logging)\.(?:log|warn|error|info|debug)\s*\(/i,
  }),
  Object.freeze({
    key: 'dependency_management',
    kind: 'dependency_management',
    name: 'Dependency Management',
    focus: 'Dependency manifests, lockfiles, package tooling, and supported install workflows.',
    pathPattern: /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile(?:\.lock)?)$/i,
  }),
]);

function scanPaths(scan) {
  return (scan.files || [])
    .map(file => typeof file === 'string' ? file : file.rel)
    .filter(file => file && scan.fileSet.has(file));
}

function evidenceMap(scan, supplied) {
  const result = {};
  for (const [file, content] of Object.entries(scan.keyFiles || {})) {
    if (scan.fileSet.has(file)) result[file] = String(content);
  }
  for (const [file, content] of Object.entries(supplied || {})) {
    if (scan.fileSet.has(file)) result[file] = String(content);
  }
  return result;
}

function scopesFromFiles(files) {
  const scopes = [];
  const seen = new Set();
  for (const file of files) {
    const slash = file.indexOf('/');
    const scope = slash === -1 ? '*' : `${file.slice(0, slash)}/**`;
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

function detectTopics(scan, suppliedEvidence = {}) {
  const files = scanPaths(scan);
  const evidence = evidenceMap(scan, suppliedEvidence);
  const topics = [];

  for (const definition of TOPICS) {
    const sourceFiles = files.filter(file => {
      const pathSignal = definition.pathPattern && definition.pathPattern.test(file);
      const textSignal = definition.textPattern
        && Object.hasOwn(evidence, file)
        && definition.textPattern.test(evidence[file]);
      return pathSignal || textSignal;
    });
    if (!sourceFiles.length) continue;
    topics.push({
      key: definition.key,
      kind: definition.kind,
      category: 'topic',
      name: definition.name,
      focus: definition.focus,
      relativePath: `topics/${definition.kind}.md`,
      scope: scopesFromFiles(sourceFiles),
      source_files: sourceFiles.slice(0, 12),
    });
  }

  return topics;
}

function normalizedList(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map(item => String(item).replace(/\\/g, '/')))]
    .sort();
}

function cardIdentity(card) {
  return [
    String(card.category || ''),
    String(card.key || ''),
    String(card.kind || ''),
    normalizedList(card.scope).join(','),
    normalizedList(card.source_files).join(','),
  ].join('|');
}

function buildKnowledgePlan(scan, modules, cardKinds, suppliedEvidence = {}) {
  const kinds = Array.isArray(cardKinds) ? cardKinds : Object.keys(cardKinds || {});
  const planned = [];

  for (const module of modules || []) {
    for (const kind of kinds) {
      planned.push({
        key: module.key || '__root__',
        kind,
        category: 'module',
        name: `${module.title} ${titleCase(kind)}`,
        focus: Array.isArray(cardKinds) ? kind : cardKinds[kind],
        relativePath: `${module.dir}/${kind}.md`,
        scope: [module.path ? `${module.path}/**` : '*'],
        source_files: [...module.scope],
        module,
      });
    }
  }
  planned.push(...detectTopics(scan, suppliedEvidence));

  const unique = new Map();
  let duplicates = 0;
  for (const card of planned) {
    const identity = cardIdentity(card);
    if (unique.has(identity)) {
      duplicates++;
      continue;
    }
    unique.set(identity, { ...card, identity });
  }

  return { cards: [...unique.values()], duplicates };
}

function yamlList(lines, key, values) {
  const items = normalizedList(values);
  if (!items.length) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const item of items) lines.push(`  - ${JSON.stringify(item)}`);
}

function renderFrontmatter(card) {
  const lines = [
    '---',
    `kind: ${JSON.stringify(String(card.kind || ''))}`,
    `category: ${JSON.stringify(String(card.category || ''))}`,
    `name: ${JSON.stringify(String(card.name || ''))}`,
  ];
  yamlList(lines, 'scope', card.scope);
  yamlList(lines, 'source_files', card.source_files);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function safeManagedPath(baseDir, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) return null;
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (!full.startsWith(`${base}${path.sep}`)) return null;
  return { rel, full };
}

function loadManifest(baseDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(baseDir, '_manifest.json'), 'utf8')
    );
    return {
      schema_version: parsed.schema_version || 1,
      files: normalizedList(parsed.files),
    };
  } catch {
    return { schema_version: 1, files: [] };
  }
}

function writeManifest(baseDir, files) {
  fs.mkdirSync(baseDir, { recursive: true });
  const target = path.join(baseDir, '_manifest.json');
  const temporary = `${target}.tmp-${process.pid}`;
  const manifest = {
    schema_version: 1,
    files: normalizedList(files),
  };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return manifest;
}

function cleanupManagedKnowledge(baseDir, previousFiles, nextFiles) {
  const next = new Set(normalizedList(nextFiles));
  const removed = [];
  for (const previous of normalizedList(previousFiles)) {
    if (next.has(previous)) continue;
    const resolved = safeManagedPath(baseDir, previous);
    if (!resolved || !fs.existsSync(resolved.full)) continue;
    const stat = fs.lstatSync(resolved.full);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    fs.unlinkSync(resolved.full);
    removed.push(resolved.rel);

    let parent = path.dirname(resolved.full);
    const base = path.resolve(baseDir);
    while (parent !== base && parent.startsWith(`${base}${path.sep}`)) {
      if (fs.readdirSync(parent).length) break;
      fs.rmdirSync(parent);
      parent = path.dirname(parent);
    }
  }
  return removed;
}

function validateKnowledgeContent(content) {
  const text = String(content).trim();
  const violations = [];
  if (hasRefusalText(text)) {
    violations.push({
      code: 'knowledge_refusal',
      message: 'knowledge card contains refusal, apology, or file/tool access failure text',
    });
  } else if (text.length < 50) {
    violations.push({
      code: 'knowledge_too_short',
      message: `knowledge card is suspiciously short (${text.length} characters)`,
    });
  }
  return { ok: violations.length === 0, violations };
}

module.exports = {
  buildKnowledgePlan,
  detectTopics,
  cardIdentity,
  renderFrontmatter,
  loadManifest,
  writeManifest,
  cleanupManagedKnowledge,
  validateKnowledgeContent,
};
