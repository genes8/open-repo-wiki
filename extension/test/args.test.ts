import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildGenerateArgs, buildModifyArgs, buildListModelsArgs } from '../src/pure/args.js';

test('generate args: json-events + language-derived out dir + optional flags', () => {
  assert.deepEqual(buildGenerateArgs({ repoRoot: '/repo', language: 'en' }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'en', 'content'),
  ]);
  assert.deepEqual(buildGenerateArgs({ repoRoot: '/repo', language: 'en', model: 'kimi', configPath: '/c.json', force: true, knowledge: true }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'en', 'content'),
    '-m', 'kimi', '--config', '/c.json', '--force', '--knowledge',
  ]);
});

test('modify args: page + op + instruction', () => {
  assert.deepEqual(buildModifyArgs({ repoRoot: '/repo', language: 'sr', pagePath: 'a.md', operation: 'supplement', instruction: 'add X', model: 'm', configPath: '/c.json' }), [
    '/repo', '--json-events', '-o', path.join('/repo', '.local-wiki', 'sr', 'content'),
    '-m', 'm', '--config', '/c.json',
    '--modify', 'a.md', '--op', 'supplement', '--instruction', 'add X',
  ]);
});

test('list-models args', () => {
  assert.deepEqual(buildListModelsArgs({ repoRoot: '/r', configPath: '/c.json' }), ['/r', '--list-models', '--json-events', '--config', '/c.json']);
  assert.deepEqual(buildListModelsArgs({ repoRoot: '/r' }), ['/r', '--list-models', '--json-events']);
});
