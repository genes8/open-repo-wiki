'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/api');

test('loadConfig honors both config and configPath keys', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cfg-'));
  const file = path.join(repo, 'my-config.json');
  fs.writeFileSync(file, JSON.stringify({ default: 'x', models: { x: { provider: 'openai', baseUrl: 'http://localhost:1/v1', model: 'm' } } }));
  const viaCamel = loadConfig({ configPath: file }, repo);
  assert.equal(viaCamel.configPath, file);
  const viaFlag = loadConfig({ config: file }, repo);
  assert.equal(viaFlag.configPath, file);
});
