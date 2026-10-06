'use strict';

const { titleCase } = require('./modules');

function sanitizePagePath(value) {
  const clean = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .map(segment => segment.replace(/[^\w.\- ]/g, '_'))
    .join('/');
  if (!clean) return null;
  return clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
}

function dirOf(pagePath) {
  const index = String(pagePath).lastIndexOf('/');
  return index === -1 ? '' : String(pagePath).slice(0, index);
}

function baseNoExt(pagePath) {
  return String(pagePath)
    .slice(String(pagePath).lastIndexOf('/') + 1)
    .replace(/\.md$/i, '');
}

// --- Source-file coverage -------------------------------------------------
// Documentation is only useful if every code file is described somewhere. The
// LLM planner routinely leaves lesser-known modules out of every page scope
// (observed on a real run: lib/citations.js and lib/sources.js were attached to
// no page, so neither was ever documented). Coverage is therefore guaranteed
// deterministically here instead of being left to the model.

// Code-file extensions worth forcing into some page's scope. Data/config/docs
// files (.json, .md, .yaml, LICENSE, ...) are intentionally excluded: they are
// supporting material the planner may cite, not modules that need a section.
const SOURCE_EXTENSIONS = Object.freeze(new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.m', '.mm', '.swift',
  '.php', '.pl', '.pm', '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl',
  '.clj', '.cljs', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.proto', '.graphql', '.gql',
]));

function extensionOf(rel) {
  const base = String(rel).slice(String(rel).lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function isCoverableFile(rel, extensions = SOURCE_EXTENSIONS) {
  return extensions.has(extensionOf(rel));
}

function scanFilePaths(scan) {
  if (Array.isArray(scan && scan.files)) {
    return scan.files
      .map(entry => (typeof entry === 'string' ? entry : entry && entry.rel))
      .filter(Boolean);
  }
  if (scan && scan.fileSet instanceof Set) return [...scan.fileSet];
  return [];
}

// Shared leading-path-segment count between two directory strings:
// ('lib', 'lib') -> 1, ('lib', 'lib/scan') -> 1, ('', 'lib') -> 0.
function dirAffinity(dirA, dirB) {
  const a = dirA ? String(dirA).split('/') : [];
  const b = dirB ? String(dirB).split('/') : [];
  let score = 0;
  while (score < a.length && score < b.length && a[score] === b[score]) score += 1;
  return score;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Which coverable source files are referenced by no page's "files" scope?
function coverageReport(pages, scan, opts = {}) {
  const extensions = opts.extensions || SOURCE_EXTENSIONS;
  const coverable = scanFilePaths(scan)
    .filter(rel => isCoverableFile(rel, extensions))
    .sort((a, b) => a.localeCompare(b));
  const covered = new Set();
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const file of page.files || []) covered.add(file);
  }
  const uncovered = coverable.filter(rel => !covered.has(rel));
  return {
    coverable,
    uncovered,
    total: coverable.length,
    coveredCount: coverable.length - uncovered.length,
    ratio: coverable.length
      ? (coverable.length - uncovered.length) / coverable.length
      : 1,
  };
}

// Append every uncovered source file to the most relevant page: highest
// directory affinity, then real pages over landings, then the fewest existing
// files, then plan order. Deterministic and idempotent, and it only appends, so
// the first attached file (which drives generation order) never changes.
function ensureFileCoverage(pages, scan, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const { uncovered } = coverageReport(list, scan, opts);
  const assigned = [];
  for (const rel of uncovered) {
    const dir = dirOf(rel);
    let best = null;
    let bestRank = null;
    for (let index = 0; index < list.length; index += 1) {
      const page = list[index];
      let affinity = 0;
      for (const file of page.files || []) {
        affinity = Math.max(affinity, dirAffinity(dirOf(file), dir));
      }
      const rank = [-affinity, page._landing ? 1 : 0, (page.files || []).length, index];
      if (bestRank === null || compareRank(rank, bestRank) < 0) {
        bestRank = rank;
        best = page;
      }
    }
    if (!best) continue;
    best.files = [...(best.files || []), rel];
    assigned.push({ file: rel, page: best.path });
  }
  return { pages: list, assigned };
}

function groupPages(pages) {
  const groups = new Map();
  for (const page of pages) {
    const dir = dirOf(page.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(page);
  }
  return groups;
}

function isExplicitLanding(page, dir) {
  if (!dir) return false;
  const dirName = dir.slice(dir.lastIndexOf('/') + 1);
  const base = baseNoExt(page.path);
  return base === dirName || base === 'index';
}

function stableFileUnion(pages, limit = 6) {
  const seen = new Set();
  const result = [];
  for (const page of pages) {
    for (const file of page.files || []) {
      if (seen.has(file)) continue;
      seen.add(file);
      result.push(file);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function annotateLandings(candidates) {
  for (const page of candidates) {
    delete page._landing;
    delete page._children;
    delete page._desc0;
    delete page._synthetic;
  }
  const groups = groupPages(candidates);
  const landingByDir = new Map();
  const landingPaths = new Set();
  const synthetic = [];

  for (const [dir, grouped] of groups) {
    if (!dir) continue;
    const explicit = grouped.find(page => isExplicitLanding(page, dir));
    const children = explicit ? grouped.filter(page => page !== explicit) : grouped;
    let landing = null;

    if (explicit && children.length > 0) {
      landing = explicit;
    } else if (!explicit && children.length >= 2) {
      const dirName = dir.slice(dir.lastIndexOf('/') + 1);
      const title = titleCase(dirName);
      landing = {
        path: `${dir}/${dirName}.md`,
        title,
        description: `Overview and navigation for the ${title} section.`,
        files: stableFileUnion(children),
        _synthetic: true,
      };
      synthetic.push(landing);
    }

    if (!landing) continue;
    landing._landing = true;
    landing._children = children;
    landing._desc0 = landing.description;
    landingByDir.set(dir, landing.path);
    landingPaths.add(landing.path);
  }

  const mainPages = candidates.filter(page => !landingPaths.has(page.path));
  const explicitLandings = candidates.filter(page => landingPaths.has(page.path));
  const pages = [...mainPages, ...explicitLandings, ...synthetic];
  const finalGroups = groupPages(pages);
  const parentByPath = new Map();
  for (const [dir, landingPath] of landingByDir) {
    const landing = pages.find(page => page.path === landingPath);
    for (const child of landing._children) parentByPath.set(child.path, landingPath);
    finalGroups.set(dir, finalGroups.get(dir) || []);
  }

  return { pages, groups: finalGroups, landingByDir, parentByPath, landingPaths };
}

// Deterministic structural repair: a landing with fewer than two children (or a
// directory holding a single non-landing page) violates the wiki shape rules
// (plan_landing_children / plan_singleton_directory). Rather than burning LLM
// repair rounds on cosmetics, merge such directories into one root-level page:
//   landing + 1 child  ->  <dirname>.md (landing title, union of files)
//   1 page, no landing ->  <dirname>-<page>.md
// Returns null when nothing needed merging.
function mergeSingletonDirectories(pages) {
  const byDir = new Map();
  for (const page of pages) {
    const dir = dirOf(page.path);
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(page);
  }
  const problemDirs = new Set();
  for (const [dir, group] of byDir) {
    const nonLanding = group.filter(page => !page._landing);
    if (nonLanding.length === 1) problemDirs.add(dir);
  }
  if (!problemDirs.size) return null;

  const taken = new Set(pages.map(page => page.path));
  const uniqueRootPath = (desired) => {
    if (!taken.has(desired)) { taken.add(desired); return desired; }
    const base = desired.replace(/\.md$/, '');
    let suffix = 2;
    while (taken.has(`${base}-${suffix}.md`)) suffix += 1;
    const unique = `${base}-${suffix}.md`;
    taken.add(unique);
    return unique;
  };

  const result = [];
  for (const page of pages) {
    const dir = dirOf(page.path);
    if (!dir || !problemDirs.has(dir)) { result.push(page); continue; }
    const group = byDir.get(dir);
    const landing = group.find(p => p._landing);
    const child = group.find(p => !p._landing);
    if (page !== child) continue; // landing (if any) is absorbed into the child
    const dirName = dir.split('/').pop();
    const base = child.path.slice(dir.length + 1).replace(/\.md$/, '');
    const target = landing
      ? uniqueRootPath(sanitizePagePath(`${dirName}.md`) || `${dirName}.md`)
      : uniqueRootPath(sanitizePagePath(`${dirName}-${base}.md`) || `${dirName}-${base}.md`);
    result.push({
      ...child,
      path: target,
      title: landing ? landing.title : child.title,
      description: [landing && landing.description, child.description].filter(Boolean).join(' ').trim() || child.description,
      files: [...new Set([...(landing ? landing.files || [] : []), ...(child.files || [])])].slice(0, 12),
      _landing: false,
      _children: [],
      _hints: child._hints || (landing && landing._hints) || '',
    });
  }
  return result;
}

function normalizePlan(rawPages, scan, { maxPages, ensureCoverage = false, coverageExtensions, requireOverview = true, mergeSingletons = true } = {}) {
  const pageLimit = Number.parseInt(maxPages, 10);
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  const seenPaths = new Set();
  let candidates = [];
  for (const raw of Array.isArray(rawPages) ? rawPages : []) {
    const pagePath = sanitizePagePath(raw && raw.path);
    const title = String(raw && raw.title || '').trim();
    if (!pagePath || !title || seenPaths.has(pagePath)) continue;
    seenPaths.add(pagePath);
    const files = [];
    const seenFiles = new Set();
    for (const file of Array.isArray(raw.files) ? raw.files : []) {
      const rel = String(file).replace(/\\/g, '/');
      if (!scan.fileSet.has(rel) || seenFiles.has(rel)) continue;
      seenFiles.add(rel);
      files.push(rel);
    }
    candidates.push({
      ...raw,
      path: pagePath,
      title,
      description: String(raw.description || '').trim(),
      files,
    });
  }

  if (requireOverview) {
    const overviewIndex = candidates.findIndex(page => page.path === 'overview.md');
    if (overviewIndex === -1) throw new Error('wiki plan must include overview.md');
    if (overviewIndex > 0) {
      const [overview] = candidates.splice(overviewIndex, 1);
      candidates.unshift(overview);
    }
  }

  let normalized = annotateLandings(candidates);
  const merged = mergeSingletons ? mergeSingletonDirectories(normalized.pages) : null;
  if (merged) {
    candidates = merged;
    normalized = annotateLandings(candidates);
  }
  while (normalized.pages.length > pageLimit) {
    let removable = -1;
    for (let index = candidates.length - 1; index >= 0; index--) {
      const page = candidates[index];
      if (page.path === 'overview.md' || normalized.landingPaths.has(page.path)) continue;
      removable = index;
      break;
    }
    if (removable === -1) {
      throw new Error(`cannot satisfy maxPages=${pageLimit} while preserving overview and landings`);
    }
    candidates.splice(removable, 1);
    normalized = annotateLandings(candidates);
  }

  const coverage = ensureCoverage
    ? ensureFileCoverage(normalized.pages, scan, { extensions: coverageExtensions })
    : null;

  return {
    pages: normalized.pages,
    groups: normalized.groups,
    landingByDir: normalized.landingByDir,
    parentByPath: normalized.parentByPath,
    ...(coverage ? { coverage } : {}),
  };
}

// Qoder strict documents mode: the page list comes from wiki_plan.yaml; the
// LLM only assigns files. Deterministic layout mirrors the landing-page
// convention: a parent page lives at <slug>/<slug>.md and its children at
// <slug>/<child-slug>.md. Parentless documents sit at the content root.
function slugifyPagePath(title) {
  const slug = sanitizePagePath(
    String(title).trim().toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
  );
  if (slug === null) {
    throw new Error(`document title cannot be converted to a page path: "${title}"`);
  }
  // sanitizePagePath appends `.md`; strip it so callers can compose directory
  // and file paths (`${slug}/${slug}.md`, `${slug}/${child}.md`).
  return slug.replace(/\.md$/i, '');
}

function planFromDocuments(documents, assignments) {
  const byTitle = new Map(documents.map(d => [d.title, d]));
  const filesByTitle = new Map(
    (Array.isArray(assignments) ? assignments : [])
      .filter(a => byTitle.has(a.title))
      .map(a => [a.title, a.files || []])
  );
  const childrenOf = new Map();
  for (const doc of documents) {
    if (!doc.parent) continue;
    if (!childrenOf.has(doc.parent)) childrenOf.set(doc.parent, []);
    childrenOf.get(doc.parent).push(doc);
  }
  const pages = [];
  for (const doc of documents) {
    if (doc.parent) continue; // emitted with the parent below
    const slug = slugifyPagePath(doc.title);
    const kids = childrenOf.get(doc.title) || [];
    if (kids.length) {
      const parentPath = `${slug}/${slug}.md`;
      pages.push({
        path: parentPath,
        title: doc.title,
        description: doc.goal || `Overview of ${doc.title}`,
        files: filesByTitle.get(doc.title) || [],
        _landing: true,
        _hints: doc.hints || '',
        _children: kids.map(kid => ({
          path: `${slug}/${slugifyPagePath(kid.title)}`,
          title: kid.title,
          description: kid.goal || '',
          files: filesByTitle.get(kid.title) || [],
          _hints: kid.hints || '',
        })),
      });
      for (const kid of kids) {
        const child = pages[pages.length - 1]._children.find(c => c.title === kid.title);
        pages.push(child);
      }
    } else {
      pages.push({
        path: `${slug}.md`,
        title: doc.title,
        description: doc.goal || '',
        files: filesByTitle.get(doc.title) || [],
        _hints: doc.hints || '',
      });
    }
  }
  const seenPaths = new Set();
  for (const page of pages) {
    if (seenPaths.has(page.path)) {
      throw new Error(`documents produce duplicate page path "${page.path}" — titles must differ after slugification`);
    }
    seenPaths.add(page.path);
  }
  return pages;
}

module.exports = {
  sanitizePagePath,
  dirOf,
  baseNoExt,
  groupPages,
  normalizePlan,
  planFromDocuments,
  isCoverableFile,
  coverageReport,
  ensureFileCoverage,
  SOURCE_EXTENSIONS,
};
