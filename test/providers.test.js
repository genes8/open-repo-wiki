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
