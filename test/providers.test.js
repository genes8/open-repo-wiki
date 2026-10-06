'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chat, chatDetailed, stripThink } = require('../lib/providers');

test('stripThink removes complete reasoning blocks only at the start', () => {
  assert.equal(
    stripThink('  <think>private reasoning</think>\n<think>more</think>\nFinal answer'),
    'Final answer'
  );
});

test('stripThink preserves literal think examples after answer content begins', () => {
  const text = 'Document `<think>reasoning</think>` exactly.';
  assert.equal(stripThink(text), text);
});

test('stripThink returns empty text for an all-reasoning response', () => {
  assert.equal(stripThink('<think>private reasoning</think>'), '');
});

test('chatDetailed returns OpenAI finish reason and usage', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: 'length',
        message: { content: '# Partial' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  });

  const result = await chatDetailed({
    provider: 'openai',
    baseUrl: 'http://mock.test/v1',
    model: 'mock',
  }, [{ role: 'user', content: 'write' }], { retries: 0 });

  assert.deepEqual(result, {
    content: '# Partial',
    finishReason: 'length',
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
});

test('chat remains content-only compatible', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: { content: '# Complete' },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 8 },
    }),
  });

  const result = await chat({
    provider: 'openai',
    baseUrl: 'http://mock.test/v1',
    model: 'mock',
  }, [{ role: 'user', content: 'write' }], { retries: 0 });

  assert.equal(result, '# Complete');
});

test('chatDetailed maps native Ollama token counts', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      done_reason: 'stop',
      message: { content: '# Complete' },
      prompt_eval_count: 7,
      eval_count: 11,
    }),
  });

  const result = await chatDetailed({
    provider: 'ollama',
    baseUrl: 'http://mock.test',
    model: 'mock',
  }, [{ role: 'user', content: 'write' }], { retries: 0 });

  assert.deepEqual(result, {
    content: '# Complete',
    finishReason: 'stop',
    usage: { prompt_tokens: 7, completion_tokens: 11 },
  });
});

function sseResponse(events, { failStatus = 0, bodyText = '' } = {}) {
  if (failStatus) return { ok: false, status: failStatus, text: async () => bodyText };
  const chunks = events.map(e => `data: ${JSON.stringify(e)}\n\n`);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, body: { getReader: () => stream.getReader() } };
}

test('chatAnthropic streams text deltas only and maps stop reason + usage', async t => {
  const { chatDetailed } = require('../lib/providers');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let captured;
  global.fetch = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'FINAL ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ANSWER' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 7 } },
    ]);
  };
  const result = await chatDetailed(
    { provider: 'anthropic', baseUrl: 'https://example.com/anthropic', model: 'glm-5.3-flash', apiKey: 'k' },
    [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    {}
  );
  assert.equal(result.content, 'FINAL ANSWER');
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7 });
  assert.equal(captured.url, 'https://example.com/anthropic/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'k');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.body.system, 'be brief');
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('chatAnthropic surfaces HTTP errors from the stream request', async t => {
  const { chatDetailed } = require('../lib/providers');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => sseResponse([], { failStatus: 429, bodyText: '{"error":{"code":"1113"}}' });
  await assert.rejects(
    chatDetailed({ provider: 'anthropic', baseUrl: 'https://e.com/a', model: 'm' }, [{ role: 'user', content: 'x' }], { retries: 0 }),
    /HTTP 429.*1113/
  );
});

test('chatAnthropic fails loudly when thinking consumed the whole budget', async t => {
  const { chatDetailed } = require('../lib/providers');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => sseResponse([
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'all reasoning' } },
  ]);
  await assert.rejects(
    chatDetailed({ provider: 'anthropic', baseUrl: 'https://example.com/a', model: 'm' }, [{ role: 'user', content: 'x' }], { retries: 0 }),
    /thinking consumed the max_tokens budget/
  );
});

test('chatAnthropic disables thinking when profile.think is false', async t => {
  const { chatDetailed } = require('../lib/providers');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let captured;
  global.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
  };
  await chatDetailed({ provider: 'anthropic', baseUrl: 'https://e.com/a', model: 'm', think: false }, [{ role: 'user', content: 'x' }], { retries: 0 });
  assert.deepEqual(captured.thinking, { type: 'disabled' });
});
