'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripThink } = require('../lib/providers');

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
