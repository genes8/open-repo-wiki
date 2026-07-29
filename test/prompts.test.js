'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pageMessages,
  repairPageMessages,
  repairPlanMessages,
} = require('../lib/prompts');
const { PAGE_PROFILES } = require('../lib/quality');

const scan = {
  name: 'demo',
  tree: 'lib/\n  a.js',
  keyFiles: {},
};
const page = {
  path: 'architecture/data-flow.md',
  title: 'Data Flow',
  description: 'Explain the real data flow.',
};
const filesBlock = '--- lib/a.js ---\nL1: one\nL2: two';
const opts = {
  language: 'English',
  attached: ['lib/a.js'],
  lineCounts: { 'lib/a.js': 8 },
  template: 'standard',
  profile: PAGE_PROFILES.architecture,
};

test('pageMessages includes bounded depth and grounded range citation rules', () => {
  const messages = pageMessages(scan, page, filesBlock, opts);
  const prompt = messages.map(message => message.content).join('\n');

  assert.match(prompt, /4-8 H2 sections/);
  assert.match(prompt, /300-1600 words/);
  assert.match(prompt, /at most 3 Mermaid diagrams/);
  assert.match(prompt, /\[lib\/a\.js:L1-L8\]\(lib\/a\.js#L1-L8\)/);
  assert.match(prompt, /- \[lib\/a\.js\]\(lib\/a\.js\)/);
  assert.match(prompt, /Section sources/);
  assert.match(prompt, /Diagram sources/);
  assert.match(prompt, /omit unsupported sections and diagrams/i);
  assert.match(prompt, /never guess or exceed numbered source lines/i);
  assert.match(prompt, /Shell commands may appear only when the exact command text is visible/i);
});

test('repairPageMessages requests a complete replacement with stable violations', () => {
  const rejected = '# Data Flow\n\nI apologize.';
  const violations = [
    { code: 'refusal_text', message: 'page contains refusal text' },
    { code: 'word_count', message: 'found 3 words' },
  ];
  const messages = repairPageMessages(
    scan,
    page,
    filesBlock,
    rejected,
    violations,
    opts
  );
  const prompt = messages.map(message => message.content).join('\n');

  assert.match(prompt, /# Data Flow\n\nI apologize\./);
  assert.match(prompt, /refusal_text: page contains refusal text/);
  assert.match(prompt, /word_count: found 3 words/);
  assert.match(prompt, /complete replacement document/i);
  assert.match(prompt, /L1: one\nL2: two/);
  assert.match(prompt, /Explain the real data flow\./);
});

test('landing prompt includes exact final child links', () => {
  const landing = {
    path: 'guides/guides.md',
    title: 'Guides',
    description: 'Guide navigation.',
    _landing: true,
    _children: [
      { path: 'guides/start.md', title: 'Start' },
      { path: 'guides/config.md', title: 'Configuration' },
    ],
  };
  const messages = pageMessages(scan, landing, filesBlock, {
    ...opts,
    profile: PAGE_PROFILES.landing,
  });
  const prompt = messages.map(message => message.content).join('\n');

  assert.match(prompt, /- \[Start\]\(start\.md\)/);
  assert.match(prompt, /- \[Configuration\]\(config\.md\)/);
});

test('repairPlanMessages requests a complete replacement for exact plan violations', () => {
  const previous = [
    { path: 'overview.md', title: 'Project Overview' },
    { path: 'architecture/providers.md', title: 'AI Providers' },
  ];
  const violations = [
    {
      code: 'plan_page_regression',
      message: 'plan has 2 pages; previous 8, minimum 6',
    },
    {
      code: 'plan_singleton_directory',
      message: 'directory guides contains one non-landing page',
    },
  ];
  const messages = repairPlanMessages(
    scan,
    previous,
    '{"pages":[{"path":"overview.md"}]}',
    violations,
    { maxPages: 20 }
  );
  const prompt = messages.map(message => message.content).join('\n');

  assert.match(prompt, /plan_page_regression: plan has 2 pages/);
  assert.match(prompt, /plan_singleton_directory: directory guides/);
  assert.match(prompt, /architecture\/providers\.md.*AI Providers/s);
  assert.match(prompt, /\{"pages":\[\{"path":"overview\.md"\}\]\}/);
  assert.match(prompt, /complete replacement JSON plan/i);
});
