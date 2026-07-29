'use strict';

const fs = require('fs');
const path = require('path');

const PER_FILE_CAP = 24000;

function lineCount(text) {
  const value = String(text);
  if (!value) return 0;
  const count = value.split('\n').length;
  return value.endsWith('\n') ? count - 1 : count;
}

function numberLines(text) {
  const value = String(text);
  if (!value) return '';
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines.map((line, index) => `L${index + 1}: ${line}`).join('\n');
}

function buildFilesBlock(repoDir, page, scan, budget) {
  const parts = [];
  const attached = [];
  const lineCounts = {};
  const rawByPath = {};
  let used = 0;
  const totalBudget = Math.max(0, Number(budget) || 0);

  for (const rel of page.files || []) {
    if (!scan.fileSet.has(rel) || used >= totalBudget) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(repoDir, rel), 'utf8');
    } catch {
      continue;
    }
    const actualLineCount = lineCount(raw);
    if (actualLineCount === 0) continue;

    const room = Math.min(PER_FILE_CAP, totalBudget - used);
    const shown = raw.slice(0, room);
    const truncated = shown.length < raw.length;
    used += shown.length;
    attached.push(rel);
    lineCounts[rel] = actualLineCount;
    rawByPath[rel] = raw;
    parts.push(
      `--- ${rel}${truncated ? ' (truncated)' : ''} ---\n${numberLines(shown)}`
    );
  }

  return {
    block: parts.join('\n\n'),
    attached,
    lineCounts,
    rawByPath,
  };
}

module.exports = { buildFilesBlock, lineCount, numberLines };
