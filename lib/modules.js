'use strict';
/**
 * Derives a coarse module map from a repository scan for the optional knowledge
 * layer. Rule-based: the repository root is one module (its top-level files),
 * and each top-level directory that contains source files becomes a module
 * scoped to that directory. This mirrors the layout Qoder's repowiki emits
 * (_index.yaml + per-module _module.yaml) so the output is tooling-compatible.
 *
 * AI-assisted refinement of the grouping is intentionally left for later; the
 * directory heuristic is deterministic and dependency-free.
 */

function titleCase(name) {
  return String(name)
    .replace(/[-_]+/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Turn a module path into a safe directory name for the knowledge tree.
function moduleDirName(modulePath, repoName) {
  if (!modulePath) return repoName;
  return modulePath.replace(/[\\/]/g, '-');
}

function moduleMap(scan) {
  const rootFiles = [];
  const byDir = new Map(); // top-level dir -> [relative path]
  for (const f of scan.files) {
    const rel = f.rel;
    const slash = rel.indexOf('/');
    if (slash === -1) {
      rootFiles.push(rel);
    } else {
      const top = rel.slice(0, slash);
      if (!byDir.has(top)) byDir.set(top, []);
      byDir.get(top).push(rel);
    }
  }

  const modules = [];
  // Root module: the repository entry point and top-level files.
  modules.push({
    key: '',
    path: '',
    dir: moduleDirName('', scan.name),
    title: scan.name,
    scope: rootFiles.sort(),
    children: [...byDir.keys()].sort(),
  });
  // One module per top-level directory that holds source files.
  for (const [top, files] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    modules.push({
      key: top,
      path: top,
      dir: moduleDirName(top, scan.name),
      title: titleCase(top),
      scope: files.sort(),
      children: [],
    });
  }
  return modules;
}

module.exports = { moduleMap, titleCase, moduleDirName };
