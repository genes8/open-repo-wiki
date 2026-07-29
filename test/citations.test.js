'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRangeTarget, sanitizeCitations } = require('../lib/citations');

const attached = ['lib/a.js'];
const lineCounts = { 'lib/a.js': 20 };

function pageWithSection(target) {
  return `<cite>
**Referenced Files in This Document**
- [lib/a.js](lib/a.js)
</cite>

## Details

Grounded detail.

**Section sources**
- [source](${target})
`;
}

test('valid whole-file inventory and ranged section citation survive', () => {
  const result = sanitizeCitations(pageWithSection('lib/a.js#L2-L8'), attached, lineCounts);

  assert.match(result.md, /\[lib\/a\.js\]\(lib\/a\.js\)/);
  assert.match(result.md, /\[source\]\(lib\/a\.js#L2-L8\)/);
  assert.equal(result.validRanges, 1);
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(parseRangeTarget('lib/a.js#L2-L8'), {
    path: 'lib/a.js',
    start: 2,
    end: 8,
  });
});

test('malformed range is dropped with citation_range_format', () => {
  const result = sanitizeCitations(pageWithSection('lib/a.js#L2-8'), attached, lineCounts);
  assert.equal(result.validRanges, 0);
  assert.equal(result.violations[0].code, 'citation_range_format');
  assert.doesNotMatch(result.md, /\*\*Section sources\*\*/);
});

test('reversed range is dropped with citation_range_order', () => {
  const result = sanitizeCitations(pageWithSection('lib/a.js#L8-L2'), attached, lineCounts);
  assert.equal(result.violations[0].code, 'citation_range_order');
});

test('out-of-bounds range is dropped with citation_range_bounds', () => {
  const result = sanitizeCitations(pageWithSection('lib/a.js#L1-L99'), attached, lineCounts);
  assert.equal(result.violations[0].code, 'citation_range_bounds');
});

test('unattached range is dropped with citation_unattached', () => {
  const result = sanitizeCitations(
    pageWithSection('lib/missing.js#L1-L2'),
    attached,
    lineCounts
  );
  assert.equal(result.violations[0].code, 'citation_unattached');
});

test('top citation inventory rejects unattached files', () => {
  const md = `<cite>
**Referenced Files in This Document**
- [missing](lib/missing.js)
</cite>`;
  const result = sanitizeCitations(md, attached, lineCounts);
  assert.equal(result.violations[0].code, 'citation_unattached');
  assert.doesNotMatch(result.md, /lib\/missing\.js/);
});
