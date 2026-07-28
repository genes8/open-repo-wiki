'use strict';
/**
 * Repository scanner: collects the file list (honoring .gitignore basics and a
 * built-in ignore list), builds a compact directory tree, extracts key project
 * files and language statistics for the planning prompt.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', '.output', 'target', 'vendor', 'coverage', '__pycache__', '.venv',
  'venv', '.idea', '.vscode', '.qoder', '.local-wiki', 'wiki-pdf', '.cache',
  '.turbo', '.pytest_cache', '.mypy_cache',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wasm', '.exe', '.dll',
  '.so', '.dylib', '.bin', '.dat', '.sqlite', '.db', '.class', '.jar', '.pyc',
  '.min.js', '.min.css', '.map', '.lock',
]);

const KEY_FILES = [
  'README.md', 'readme.md', 'README.rst', 'package.json', 'pyproject.toml',
  'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'Gemfile', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'tsconfig.json',
];

const MAX_FILE_SIZE = 200 * 1024; // skip files bigger than this
const KEY_FILE_TRUNC = 4000;      // chars of each key file shown to the planner

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Minimal .gitignore support: plain names, globs and path prefixes.
// Negations and complex patterns are intentionally ignored.
function gitignoreMatchers(repoDir) {
  const file = path.join(repoDir, '.gitignore');
  const matchers = [];
  if (!fs.existsSync(file)) return matchers;
  for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const pat = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat) continue;
    const rx = new RegExp('^' + pat.split('*').map(escapeRx).join('[^/]*') + '$');
    matchers.push((rel) => {
      if (rx.test(rel)) return true;
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        if (rx.test(parts[i])) return true;
        if (rx.test(parts.slice(0, i + 1).join('/'))) return true;
      }
      return false;
    });
  }
  return matchers;
}

function isBinaryName(name) {
  const lower = name.toLowerCase();
  for (const ext of BINARY_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function scanRepo(repoDir) {
  const ignored = gitignoreMatchers(repoDir);
  const files = [];

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;           // skip all dot-directories
        if (entry.name !== '.gitignore') continue;   // and most dotfiles
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        if (ignored.some(m => m(rel))) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (isBinaryName(entry.name)) continue;
        if (ignored.some(m => m(rel))) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size > MAX_FILE_SIZE) continue;
        files.push({ rel, size });
      }
    }
  };
  walk(repoDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // Compact indented tree, capped so huge repos don't blow up the prompt
  const treeLines = [];
  const seen = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      treeLines.push('  '.repeat(i) + parts[i] + (i < parts.length - 1 ? '/' : ''));
    }
  }
  const TREE_CAP = 400;
  const tree = treeLines.length > TREE_CAP
    ? treeLines.slice(0, TREE_CAP).join('\n') + `\n... (${treeLines.length - TREE_CAP} more entries)`
    : treeLines.join('\n');

  // Key project files (truncated) for planning context
  const keyFiles = {};
  for (const name of KEY_FILES) {
    const full = path.join(repoDir, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      let content = fs.readFileSync(full, 'utf8');
      if (content.length > KEY_FILE_TRUNC) content = content.slice(0, KEY_FILE_TRUNC) + '\n... (truncated)';
      keyFiles[name] = content;
    }
  }

  // Language stats by extension
  const byExt = {};
  for (const f of files) {
    const ext = path.extname(f.rel) || '(none)';
    byExt[ext] = byExt[ext] || { count: 0, bytes: 0 };
    byExt[ext].count++;
    byExt[ext].bytes += f.size;
  }
  const langStats = Object.entries(byExt)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([ext, s]) => `${ext}: ${s.count} files, ${(s.bytes / 1024).toFixed(0)} KB`)
    .join('; ');

  return {
    files,
    fileSet: new Set(files.map(f => f.rel)),
    tree,
    keyFiles,
    langStats,
    name: path.basename(path.resolve(repoDir)),
  };
}

module.exports = { scanRepo };
