import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCatalog, type CatalogPage } from '../src/pure/catalog.js';

function fixture(): { repo: string; page: CatalogPage } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-cat-'));
  const page: CatalogPage = {
    path: 'guides/testing.md', title: 'Testing', description: 'd',
    dependent_files: ['test/a.test.js'], parent: 'guides/guides.md',
    isLanding: false, quality: 'ok', protected: false,
  };
  const meta = path.join(repo, '.local-wiki', 'en', 'meta');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'catalog.json'), JSON.stringify({
    repo: 'r', model: 'm', language: 'en', generatedAt: 'now', pages: [page],
  }));
  return { repo, page };
}

test('readCatalog returns parsed catalog', () => {
  const { repo, page } = fixture();
  const catalog = readCatalog(repo, 'en');
  assert.ok(catalog);
  assert.deepEqual(catalog.pages[0], page);
});

test('readCatalog returns null when absent or malformed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-cat-'));
  assert.equal(readCatalog(repo, 'en'), null);
  const meta = path.join(repo, '.local-wiki', 'en', 'meta');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'catalog.json'), '{oops');
  assert.equal(readCatalog(repo, 'en'), null);
});
