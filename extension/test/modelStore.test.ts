import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readManagedConfig,
  writeManagedConfig,
  writeApiKey,
  envVarNameFor,
  profileToEngineConfig,
} from '../src/pure/modelStore.js';

const tmpdir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'modelStore-'));

test('readManagedConfig/writeManagedConfig round-trips default and models', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'repo-wiki.config.json');
  writeManagedConfig(configPath, { default: 'a', models: { a: { provider: 'openai', baseUrl: 'http://x/v1', model: 'm' } } });
  assert.deepEqual(readManagedConfig(configPath), {
    default: 'a',
    models: { a: { provider: 'openai', baseUrl: 'http://x/v1', model: 'm' } },
  });
});

test('readManagedConfig returns empty models for a missing or invalid file', () => {
  const dir = tmpdir();
  assert.deepEqual(readManagedConfig(path.join(dir, 'missing.json')), { models: {} });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.deepEqual(readManagedConfig(bad), { models: {} });
});

test('writeApiKey replaces an existing variable line in place', () => {
  const dir = tmpdir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'A=1\nREPO_WIKI_KEY_FOO=old\nB=2\n');
  writeApiKey(envPath, 'REPO_WIKI_KEY_FOO', 'new-key');
  const text = fs.readFileSync(envPath, 'utf8');
  assert.ok(text.includes('REPO_WIKI_KEY_FOO=new-key'), 'replaced value present');
  assert.ok(!text.includes('old'), 'old value removed');
  assert.ok(text.includes('A=1') && text.includes('B=2'), 'unrelated lines preserved');
  assert.ok(text.endsWith('\n'), 'file keeps trailing newline');
});

test('writeApiKey appends a new variable (new and non-newline-terminated files)', () => {
  const dir = tmpdir();
  const envPath = path.join(dir, '.env');
  writeApiKey(envPath, 'REPO_WIKI_KEY_NEW', 'sk-1');
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'REPO_WIKI_KEY_NEW=sk-1\n');

  const second = path.join(dir, 'second.env');
  fs.writeFileSync(second, 'A=1'); // no trailing newline
  writeApiKey(second, 'REPO_WIKI_KEY_NEW', 'sk-2');
  assert.equal(fs.readFileSync(second, 'utf8'), 'A=1\nREPO_WIKI_KEY_NEW=sk-2\n');
});

test('envVarNameFor upper-cases and sanitizes profile names', () => {
  assert.equal(envVarNameFor('My Model'), 'REPO_WIKI_KEY_MY_MODEL');
  assert.equal(envVarNameFor('zhipu-glm'), 'REPO_WIKI_KEY_ZHIPU_GLM');
  assert.equal(envVarNameFor('a b_c-d'), 'REPO_WIKI_KEY_A_B_C_D');
});

test('profileToEngineConfig maps a profile to the engine config shape', () => {
  assert.deepEqual(
    profileToEngineConfig({ name: 'glm', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'm', concurrency: 2, think: false }),
    {
      provider: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      apiKey: 'env:REPO_WIKI_KEY_GLM',
      maxTokens: 16384,
      concurrency: 2,
      think: false,
    },
  );
});

test('profileToEngineConfig defaults maxTokens and omits optional flags', () => {
  assert.deepEqual(
    profileToEngineConfig({ name: 'ollama-qwen', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen' }),
    {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen',
      apiKey: 'env:REPO_WIKI_KEY_OLLAMA_QWEN',
      maxTokens: 16384,
    },
  );
});
