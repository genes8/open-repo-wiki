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

function normalizePlan(rawPages, scan, { maxPages }) {
  const pageLimit = Number.parseInt(maxPages, 10);
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  const seenPaths = new Set();
  const candidates = [];
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

  const overviewIndex = candidates.findIndex(page => page.path === 'overview.md');
  if (overviewIndex === -1) throw new Error('wiki plan must include overview.md');
  if (overviewIndex > 0) {
    const [overview] = candidates.splice(overviewIndex, 1);
    candidates.unshift(overview);
  }

  let normalized = annotateLandings(candidates);
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

  return {
    pages: normalized.pages,
    groups: normalized.groups,
    landingByDir: normalized.landingByDir,
    parentByPath: normalized.parentByPath,
  };
}

module.exports = {
  sanitizePagePath,
  dirOf,
  baseNoExt,
  groupPages,
  normalizePlan,
};
