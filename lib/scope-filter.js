'use strict';
/**
 * wiki_plan scope.include/exclude — gitignore-flavored globs applied to a
 * finished scan. Supported: '*' within a segment, '**' across segments,
 * trailing '/' (directory prefix), leading '/' (anchor at repo root).
 * include (when non-empty) is an allowlist; exclude always removes.
 */
const { buildTreeLines, buildLangStats } = require('./scan');

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compilePattern(pattern) {
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = body.split('/');
  const segmentRx = segments.map(seg => (
    seg === '**'
      ? '(?:[^/]+/)*[^/]*'      // any number of full segments + a partial one
      : seg.split('*').map(escapeRx).join('[^/]*')
  ));
  // A '**' segment followed by more segments must also allow matching a prefix
  // of full segments: 'src/**' should match 'src/a/b.js'.
  let rx = '^';
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '**') {
      rx += i === segments.length - 1 ? '(?:[^/]+/)*[^/]*' : '(?:[^/]+/)*';
    } else {
      rx += segmentRx[i];
      if (i < segments.length - 1) rx += '/';
    }
  }
  const full = new RegExp(rx + '$');
  return (rel) => {
    if (full.test(rel)) return true;
    if (directory) {
      // 'src/' matches everything under src/
      const prefix = body + '/';
      return rel === body || rel.startsWith(prefix);
    }
    if (!anchored) {
      // unanchored patterns may match from any directory boundary
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (full.test(parts.slice(i).join('/'))) return true;
      }
      // bare-name patterns match a single segment anywhere ('*.md')
      if (!body.includes('/')) return full.test(rel.split('/').pop());
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
    const err = new Error('wiki_plan scope excludes every scanned file — refusing to plan an empty wiki');
    err.code = 'empty_scope';
    throw err;
  }
  return {
    ...scan,
    files,
    fileSet: new Set(files.map(f => f.rel)),
    tree: buildTreeLines(files),
    langStats: buildLangStats(files),
  };
}

module.exports = { applyScope, compilePattern };
