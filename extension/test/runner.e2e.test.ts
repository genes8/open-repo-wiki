import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineRunner } from '../src/engineRunner.js';
import type { WikiEvent } from '../src/pure/events.js';

// Compiled to out-test/test/*.js, so the extension root is two levels up
// from __dirname (out-test/test -> out-test -> extension root).
const extensionRoot = path.resolve(__dirname, '..', '..');
const bundledGenerate = path.join(extensionRoot, 'dist', 'engine', 'generate.cjs');
const skip = !fs.existsSync(bundledGenerate) ? 'run npm run compile first' : false;

test('runner spawns the bundled engine and streams model_profile events', { skip }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ext-run-'));
  const configPath = path.join(repo, 'repo-wiki.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    default: 'mock', language: 'en',
    models: { mock: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-1' } },
  }));
  const events: WikiEvent[] = [];
  const logs: string[] = [];
  const runner = new EngineRunner();
  const result = await runner.run(process.execPath, bundledGenerate, [], {}, {
    args: [repo, '--list-models', '--json-events', '--config', configPath],
    cwd: repo,
    onEvent: e => events.push(e),
    onLog: l => logs.push(l),
  });
  assert.equal(result.code, 0, logs.join('\n'));
  assert.ok(events.some(e => e.type === 'model_profile'), 'expected model_profile events');
  for (const e of events) assert.ok(typeof e.ts === 'string' && e.ts.length > 0);
});

test('runner reports spawn failures without throwing', { skip }, async () => {
  const runner = new EngineRunner();
  const result = await runner.run('/nonexistent-node-binary-xyz', bundledGenerate, [], {}, {
    args: ['--list-models'], cwd: process.cwd(), onEvent: () => {},
  });
  assert.equal(result.code, -1);
  assert.equal(result.errorEvent?.code, 'spawn_failed');
});
