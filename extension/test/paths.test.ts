import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiPaths } from '../src/pure/paths.js';
import * as path from 'node:path';

test('wikiPaths mirrors the engine output layout', () => {
  const p = wikiPaths('/repo', 'en');
  assert.equal(p.outDir, path.join('/repo', '.local-wiki', 'en', 'content'));
  assert.equal(p.metaDir, path.join('/repo', '.local-wiki', 'en', 'meta'));
  assert.equal(p.catalogPath, path.join('/repo', '.local-wiki', 'en', 'meta', 'catalog.json'));
  const sr = wikiPaths('/repo', 'sr');
  assert.ok(sr.catalogPath.includes(path.join('.local-wiki', 'sr')));
});
