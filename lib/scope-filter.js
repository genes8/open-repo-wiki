'use strict';
/**
 * wiki_plan scope.include/exclude — gitignore-flavored globs applied to a
 * finished scan. Supported: '*' within a segment, '**' across segments,
 * trailing '/' (directory prefix), leading '/' (anchor at repo root).
 * include (when non-empty) is an allowlist; exclude always removes.
 */
const { buildTreeLines, buildLangStats } = require('./scan');

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Glob → regex translation.
//
// Chosen semantics (gitignore wins where gitignore and shell globs differ):
// - '**' matches any number of full path segments (zero or more).
// - '*' matches any run of characters within a single segment.
// - A leading '/' anchors the first segment to the repo root.
// - A trailing '/' matches the directory itself AND everything under it.
// - A pattern whose body contains no '/' (e.g. 'src/' or '*.md') is unanchored
//   and may match at any directory depth; a body containing '/' is
//   root-relative unless it begins with '**' (whose own prefix re-covers any
//   depth).
function compilePattern(pattern) {
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = body.split('/');
  const segRx = seg => seg.split('*').map(escapeRx).join('[^/]*');

  // Join segment translations into a path regex. '**' matches any number of
  // full segments and already consumes its following '/', so only non-'**'
  // segments emit a '/' before the next segment.
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '**') {
      prefix += '(?:[^/]+/)*';
    } else {
      prefix += segRx(segments[i]);
      if (i < segments.length - 1) prefix += '/';
    }
  }

  if (directory) {
    // 'src/' matches the directory itself and anything below it:
    // prefix + optional '/.*'. '**/test/' → '(?:[^/]+/)*test(?:/.*)?$'.
    const dirRx = new RegExp('^' + prefix + '(?:/.*)?$');
    return (rel) => {
      if (dirRx.test(rel)) return true;
      if (!anchored && !body.includes('/')) {
        // gitignore: a pattern with no slash matches at any depth, so an
        // unanchored bare directory name ('src/') matches any 'src' directory.
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) {
          if (dirRx.test(parts.slice(i).join('/'))) return true;
        }
      }
      return false;
    };
  }

  // Full (non-directory) pattern. A trailing '**' also matches a partial final
  // segment: 'src/**' matches both 'src/a.js' and 'src/a/b.js'.
  let rx = '^' + prefix;
  if (segments.length && segments[segments.length - 1] === '**') rx += '[^/]*';
  const full = new RegExp(rx + '$');
  return (rel) => {
    if (full.test(rel)) return true;
    if (!anchored) {
      // Unanchored patterns may match from any directory boundary.
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (full.test(parts.slice(i).join('/'))) return true;
      }
    }
    return false;
  };
}

function applyScope(scan, scope) {
  const include = (scope && scope.include) || [];
  const exclude = (scope && scope.exclude) || [];
  if (!include.length && !exclude.length) return scan;
  const includeMatchers = include.map(compilePattern);
  const excludeMatchers = exclude.map(compilePattern);
  const files = scan.files.filter(f => {
    if (excludeMatchers.some(m => m(f.rel))) return false;
    if (include.length && !includeMatchers.some(m => m(f.rel))) return false;
    return true;
  });
  if (files.length === 0) {
    const err = new Error('wiki_plan scope leaves no scannable files (include matched nothing or exclude removed everything) — refusing to plan an empty wiki');
    err.code = 'empty_scope';
    throw err;
  }
  const fileSet = new Set(files.map(f => f.rel));
  return {
    ...scan,
    files,
    fileSet,
    keyFiles: Object.fromEntries(
      Object.entries(scan.keyFiles || {}).filter(([key]) => fileSet.has(key))
    ),
    tree: buildTreeLines(files),
    langStats: buildLangStats(files),
  };
}

module.exports = { applyScope, compilePattern };
