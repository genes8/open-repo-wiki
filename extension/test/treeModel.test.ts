import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildTree, pageUriPath, resolveHref } from '../src/pure/treeModel.js';
import type { CatalogPage } from '../src/pure/catalog.js';

const mk = (over: Partial<CatalogPage>): CatalogPage => ({
  path: 'x.md', title: 'X', description: '', dependent_files: [],
  parent: null, isLanding: false, quality: 'ok', protected: false, ...over,
});

test('buildTree nests children under parents and keeps catalog order', () => {
  const pages = [
    mk({ path: 'overview.md', title: 'Overview' }),
    mk({ path: 'guides/guides.md', title: 'Guides', isLanding: true }),
    mk({ path: 'guides/testing.md', title: 'Testing', parent: 'guides/guides.md' }),
    mk({ path: 'guides/deploy.md', title: 'Deploy', parent: 'guides/guides.md' }),
  ];
  const tree = buildTree({ repo: 'r', model: 'm', language: 'en', generatedAt: '', pages });
  assert.deepEqual(tree.map(n => n.page.path), ['overview.md', 'guides/guides.md']);
  const guides = tree[1];
  assert.deepEqual(guides.children.map(n => n.page.path), ['guides/testing.md', 'guides/deploy.md']);
});

test('orphans (unknown parent) surface at root instead of vanishing', () => {
  const pages = [mk({ path: 'a.md', parent: 'ghost.md' })];
  const tree = buildTree({ repo: 'r', model: 'm', language: 'en', generatedAt: '', pages });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].page.path, 'a.md');
});

test('pageUriPath produces repo-relative file paths', () => {
  assert.equal(pageUriPath('guides/testing.md'), path.join('.local-wiki', 'en', 'content', 'guides/testing.md'));
});

test('resolveHref resolves relative markdown links against the current page', () => {
  const pages = [
    mk({ path: 'overview.md', title: 'O' }),
    mk({ path: 'guides/guides.md', title: 'G', isLanding: true }),
    mk({ path: 'guides/testing.md', title: 'T', parent: 'guides/guides.md' }),
  ];
  const catalog = { repo: 'r', model: 'm', language: 'en', generatedAt: '', pages };
  assert.equal(resolveHref(catalog, 'guides/testing.md', 'guides.md'), 'guides/guides.md');
  assert.equal(resolveHref(catalog, 'guides/testing.md', '../overview.md'), 'overview.md');
  assert.equal(resolveHref(catalog, 'overview.md', 'guides/testing.md'), 'guides/testing.md');
  assert.equal(resolveHref(catalog, 'overview.md', 'https://x.dev/a.md'), null);
});
