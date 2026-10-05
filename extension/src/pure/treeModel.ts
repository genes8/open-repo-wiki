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
