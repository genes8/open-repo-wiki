'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { deriveOutputLayout } = require('../lib/output-layout');

test('keeps the standard language content layout', () => {
  const content = path.resolve('/tmp/demo/.local-wiki/en/content');
  assert.deepEqual(deriveOutputLayout(content, 'en'), {
    localWikiRoot: path.resolve('/tmp/demo/.local-wiki'),
    metaDir: path.resolve('/tmp/demo/.local-wiki/en/meta'),
    knowledgeBase: path.resolve('/tmp/demo/.local-wiki/knowledge/en'),
    runsDir: path.resolve('/tmp/demo/.local-wiki/runs'),
    structured: true,
  });
});

test('isolates flat custom output support data beside that output', () => {
  const content = path.resolve('/tmp/wiki-out');
  assert.deepEqual(deriveOutputLayout(content, 'en'), {
    localWikiRoot: path.resolve('/tmp/wiki-out.local-wiki'),
    metaDir: path.resolve('/tmp/meta'),
    knowledgeBase: path.resolve('/tmp/wiki-out.local-wiki/knowledge/en'),
    runsDir: path.resolve('/tmp/wiki-out.local-wiki/runs'),
    structured: false,
  });
});

test('rejects an unsafe language path segment', () => {
  assert.throws(
    () => deriveOutputLayout('/tmp/wiki-out', '../outside'),
    /unsafe wiki language/
  );
});
