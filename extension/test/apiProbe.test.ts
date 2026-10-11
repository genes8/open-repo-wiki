import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeOpenAI, probeAnthropic, probeOllama } from '../src/pure/apiProbe.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;

const failedResponse = (status: number, body: string): Response =>
  ({ ok: false, status, text: async () => body }) as unknown as Response;

const rejectedFetch = (message: string): typeof fetch =>
  (async () => { throw Object.assign(new Error(message), { name: 'AbortError' }); }) as unknown as typeof fetch;

test('probeOpenAI: ok', async () => {
  globalThis.fetch = (async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] })) as unknown as typeof fetch;
  assert.deepEqual(await probeOpenAI('http://localhost:1234/v1', 'key', 'm'), { ok: true });
});

test('probeOpenAI: 429', async () => {
  globalThis.fetch = (async () => failedResponse(429, 'rate limited')) as unknown as typeof fetch;
  const result = await probeOpenAI('http://localhost:1234/v1', 'key', 'm');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /429/);
});

test('probeOpenAI: abort', async () => {
  globalThis.fetch = rejectedFetch('signal timed out');
  const result = await probeOpenAI('http://localhost:1234/v1', 'key', 'm');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /signal timed out/);
});

test('probeAnthropic: ok', async () => {
  globalThis.fetch = (async () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] })) as unknown as typeof fetch;
  assert.deepEqual(await probeAnthropic('https://open.bigmodel.cn/api/anthropic', 'key', 'm'), { ok: true });
});

test('probeAnthropic: 429', async () => {
  globalThis.fetch = (async () => failedResponse(429, 'rate limited')) as unknown as typeof fetch;
  const result = await probeAnthropic('https://open.bigmodel.cn/api/anthropic', 'key', 'm');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /429/);
});

test('probeAnthropic: abort', async () => {
  globalThis.fetch = rejectedFetch('signal timed out');
  const result = await probeAnthropic('https://open.bigmodel.cn/api/anthropic', 'key', 'm');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /signal timed out/);
});

test('probeOllama: ok', async () => {
  globalThis.fetch = (async () => jsonResponse({ message: { content: 'ok' } })) as unknown as typeof fetch;
  assert.deepEqual(await probeOllama('http://localhost:11434', 'qwen'), { ok: true });
});
