import type { Catalog, CatalogPage } from './catalog.js';
import { wikiPaths } from './paths.js';
import * as path from 'node:path';

export interface TreeNode { page: CatalogPage; children: TreeNode[] }

export function buildTree(catalog: Catalog): TreeNode[] {
  const byPath = new Map(catalog.pages.map(p => [p.path, p]));
  const nodes = new Map<string, TreeNode>(catalog.pages.map(p => [p.path, { page: p, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = node.page.parent;
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (parent && parent.path !== node.page.path) {
      nodes.get(parent.path)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function pageUriPath(pagePath: string, language = 'en'): string {
  const { outDir } = wikiPaths('', language);
  return path.join(outDir, pagePath);
}

export function resolveHref(catalog: Catalog, currentPagePath: string, href: string): string | null {
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return null;
  const clean = href.split('#')[0].trim();
  if (!clean || !clean.toLowerCase().endsWith('.md')) return null;
  const baseDir = currentPagePath.includes('/') ? currentPagePath.slice(0, currentPagePath.lastIndexOf('/')) : '';
  const joined = clean.startsWith('/') ? clean.slice(1) : (baseDir ? `${baseDir}/${clean}` : clean);
  const normalized: string[] = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { normalized.pop(); continue; }
    normalized.push(segment);
  }
  const target = normalized.join('/');
  if (catalog.pages.some(p => p.path === target)) return target;
  const byBasename = catalog.pages.find(p => p.path.endsWith(`/${target}`) || p.path === target);
  return byBasename ? byBasename.path : null;
}
