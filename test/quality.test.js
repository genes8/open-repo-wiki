'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPage, validatePage } = require('../lib/quality');

function validPage({
  title = 'Topic',
  sections = 4,
  words = 220,
  mermaids = 0,
  includeCite = true,
  includeRange = true,
  children = [],
} = {}) {
  const out = [`# ${title}`];
  if (includeCite) {
    out.push(
      '<cite>',
      '**Referenced Files in This Document**',
      '- [lib/a.js](lib/a.js)',
      '</cite>'
    );
  }
  const wordsPerSection = Math.ceil(words / sections);
  for (let index = 0; index < sections; index++) {
    out.push(`## Section ${index + 1}`);
    const child = children[index];
    if (child) out.push(`[${child.title}](${child.path.split('/').at(-1)})`);
    out.push(`${Array.from({ length: wordsPerSection }, () => 'grounded').join(' ')}.`);
    if (includeRange && index === 0) {
      out.push('**Section sources**', '- [lib/a.js:L1-L5](lib/a.js#L1-L5)');
    }
  }
  for (let index = 0; index < mermaids; index++) {
    out.push('```mermaid', `flowchart LR\n  A${index} --> B${index}`, '```');
  }
  return out.join('\n\n');
}

function codes(result) {
  return result.violations.map(item => item.code);
}

const page = { path: 'guides/topic.md', title: 'Topic' };
const context = {
  page,
  attached: ['lib/a.js'],
  citationResult: { validRanges: 1, violations: [] },
  completion: { finishReason: 'stop' },
  rawByPath: { 'lib/a.js': 'source evidence without shell commands' },
};

test('classifyPage selects deterministic page profiles', () => {
  assert.equal(classifyPage({ path: 'architecture/data-flow.md' }).name, 'architecture');
  assert.equal(classifyPage({ path: 'reference/cli.md' }).name, 'architecture');
  assert.equal(classifyPage({ path: 'guides/start.md' }).name, 'guide');
  assert.equal(classifyPage({ path: 'guides/guides.md', _landing: true }).name, 'landing');
  assert.equal(classifyPage({ path: 'overview.md' }).name, 'overview');
});

test('valid page passes the guide profile', () => {
  assert.equal(validatePage(validPage(), context).ok, true);
});

test('rejects refusal text', () => {
  const result = validatePage(`${validPage()}\n\nI apologize, but I cannot access the files.`, context);
  assert.ok(codes(result).includes('refusal_text'));
});

test('rejects multiple H1 headings', () => {
  const result = validatePage(`# Other\n\n${validPage()}`, context);
  assert.ok(codes(result).includes('h1_count'));
});

test('rejects an H1 that does not match the planned title', () => {
  const result = validatePage(validPage({ title: 'Wrong' }), context);
  assert.ok(codes(result).includes('h1_title'));
});

test('rejects empty inline code', () => {
  const result = validatePage(`${validPage()}\n\nEmpty example: \`\`.`, context);
  assert.ok(codes(result).includes('empty_inline_code'));
});

test('rejects too few H2 sections for the profile', () => {
  const result = validatePage(validPage({ sections: 2 }), context);
  assert.ok(codes(result).includes('section_count'));
});

test('rejects pages outside the profile word bounds', () => {
  const result = validatePage(validPage({ words: 20 }), context);
  assert.ok(codes(result).includes('word_count'));
});

test('rejects too many Mermaid diagrams for the profile', () => {
  const result = validatePage(validPage({ mermaids: 2 }), context);
  assert.ok(codes(result).includes('mermaid_count'));
});

test('rejects unbalanced Markdown fences', () => {
  const result = validatePage(`${validPage()}\n\n\`\`\`js\nconst open = true;`, context);
  assert.ok(codes(result).includes('unbalanced_fence'));
});

test('rejects unbalanced GFM tilde fences', () => {
  const result = validatePage(`${validPage()}\n\n~~~bash\nnode unsafe.js`, context);
  assert.ok(codes(result).includes('unbalanced_fence'));
});

test('does not treat a four-space-indented marker as a GFM closing fence', () => {
  const result = validatePage(
    `${validPage()}\n\n~~~bash\nnode --test test/*.test.js\n    ~~~\ncurl evil`,
    {
      ...context,
      visibleByPath: { 'lib/a.js': 'node --test test/*.test.js' },
    }
  );
  assert.ok(codes(result).includes('unbalanced_fence'));
  assert.ok(codes(result).includes('ungrounded_command'));
});

test('rejects a sourced page without its expected citation inventory', () => {
  const result = validatePage(validPage({ includeCite: false }), context);
  assert.ok(codes(result).includes('missing_cite'));
});

test('rejects a sourced non-landing page without a valid line range', () => {
  const result = validatePage(validPage({ includeRange: false }), {
    ...context,
    citationResult: { validRanges: 0, violations: [] },
  });
  assert.ok(codes(result).includes('missing_range_citation'));
});

test('rejects a landing that omits an expected child link', () => {
  const children = [
    { path: 'guides/a.md', title: 'A' },
    { path: 'guides/b.md', title: 'B' },
  ];
  const landing = {
    path: 'guides/guides.md',
    title: 'Guides',
    _landing: true,
    _children: children,
  };
  const md = validPage({
    title: 'Guides',
    sections: 2,
    words: 150,
    includeRange: false,
    children: [children[0]],
  });
  const result = validatePage(md, {
    page: landing,
    attached: ['lib/a.js'],
    citationResult: { validRanges: 0, violations: [] },
  });
  assert.ok(codes(result).includes('landing_child_link'));
});

test('propagates citation sanitizer violations', () => {
  const result = validatePage(validPage(), {
    ...context,
    citationResult: {
      validRanges: 1,
      violations: [{
        code: 'citation_range_bounds',
        target: 'lib/a.js#L1-L99',
        message: 'out of bounds',
      }],
    },
  });
  assert.ok(codes(result).includes('citation_range_bounds'));
});

test('rejects token-limited completions', () => {
  const result = validatePage(validPage(), {
    ...context,
    completion: { finishReason: 'length' },
  });
  assert.ok(codes(result).includes('completion_truncated'));
});

test('rejects a final section ending mid-sentence', () => {
  const broken = validPage().replace(/\.$/, '');
  const result = validatePage(broken, context);
  assert.ok(codes(result).includes('incomplete_ending'));
  assert.equal(codes(result).includes('incomplete_final_section'), false);
});

test('rejects a final section without enough substantive content', () => {
  const broken = validPage().replace(
    /## Section 4[\s\S]*$/,
    '## Section 4\n\nShort ending.'
  );
  const result = validatePage(broken, context);
  assert.ok(codes(result).includes('incomplete_final_section'));
  assert.equal(codes(result).includes('incomplete_ending'), false);
});

test('accepts a short final section with two complete list items', () => {
  const completeList = validPage().replace(
    /## Section 4[\s\S]*$/,
    '## Section 4\n\n- First supported outcome.\n- Second supported outcome.'
  );
  const result = validatePage(completeList, context);
  assert.equal(codes(result).includes('incomplete_final_section'), false);
  assert.equal(codes(result).includes('incomplete_ending'), false);
});

test('accepts a final section containing a complete tilde code fence', () => {
  const completeFence = validPage().replace(
    /## Section 4[\s\S]*$/,
    '## Section 4\n\n~~~bash\nnode --test test/*.test.js\n~~~'
  );
  const result = validatePage(completeFence, {
    ...context,
    visibleByPath: { 'lib/a.js': 'node --test test/*.test.js' },
  });
  assert.equal(codes(result).includes('incomplete_final_section'), false);
  assert.equal(codes(result).includes('incomplete_ending'), false);
});

test('rejects shell commands absent from attached sources', () => {
  const broken = validPage().replace(
    /grounded\.$/,
    'grounded.\n\n```bash\nnode test/*.test.js\n```\n\nFinal sentence.'
  );
  const result = validatePage(broken, {
    ...context,
    rawByPath: { 'lib/a.js': '"test":"node --test test/*.test.js"' },
  });
  assert.ok(codes(result).includes('ungrounded_command'));
});

test('accepts exact source-backed shell commands', () => {
  const grounded = validPage().replace(
    /grounded\.$/,
    'grounded.\n\n```bash\nnode --test test/*.test.js\n```\n\nFinal sentence.'
  );
  const result = validatePage(grounded, {
    ...context,
    rawByPath: { 'lib/a.js': '"test":"node --test test/*.test.js"' },
  });
  assert.equal(codes(result).includes('ungrounded_command'), false);
});

test('does not combine separate source files to ground one shell command', () => {
  const commandPage = validPage().replace(
    /grounded\.$/,
    'grounded.\n\n```bash\nnode --test test/*.test.js\n```\n\nFinal sentence.'
  );
  const result = validatePage(commandPage, {
    ...context,
    attached: ['lib/a.js', 'lib/b.js'],
    rawByPath: {
      'lib/a.js': 'node --test',
      'lib/b.js': 'test/*.test.js',
    },
  });
  assert.ok(codes(result).includes('ungrounded_command'));
});

test('rejects ungrounded commands in GFM tilde shell fences', () => {
  for (const language of ['bash', 'sh', 'console']) {
    const commandPage = validPage().replace(
      /grounded\.$/,
      `grounded.\n\n~~~${language}\nnode unsafe.js\n~~~\n\nFinal sentence.`
    );
    const result = validatePage(commandPage, context);
    assert.ok(
      codes(result).includes('ungrounded_command'),
      `expected ${language} tilde fence to be validated`
    );
  }
});

test('rejects a command present only beyond the visible source cutoff', () => {
  const commandPage = validPage().replace(
    /grounded\.$/,
    'grounded.\n\n```bash\nnode hidden.js\n```\n\nFinal sentence.'
  );
  const result = validatePage(commandPage, {
    ...context,
    rawByPath: { 'lib/a.js': 'visible prefix\nnode hidden.js\n' },
    visibleByPath: { 'lib/a.js': 'visible prefix\n' },
  });
  assert.ok(codes(result).includes('ungrounded_command'));
});
