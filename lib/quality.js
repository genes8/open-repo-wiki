'use strict';

const PAGE_PROFILES = Object.freeze({
  landing: Object.freeze({
    name: 'landing',
    minSections: 2,
    maxSections: 4,
    minWords: 120,
    maxWords: 700,
    maxMermaid: 1,
  }),
  guide: Object.freeze({
    name: 'guide',
    minSections: 3,
    maxSections: 6,
    minWords: 200,
    maxWords: 1100,
    maxMermaid: 1,
  }),
  overview: Object.freeze({
    name: 'overview',
    minSections: 4,
    maxSections: 7,
    minWords: 280,
    maxWords: 1400,
    maxMermaid: 2,
  }),
  architecture: Object.freeze({
    name: 'architecture',
    minSections: 4,
    maxSections: 8,
    minWords: 300,
    maxWords: 1600,
    maxMermaid: 3,
  }),
});

const REFUSAL_PATTERNS = [
  /\bI apologize\b/i,
  /\bI(?:'m| am) (?:sorry|unable|not able)\b/i,
  /\b(?:cannot|can't) (?:access|read|proceed|continue)\b/i,
  /\bfile access tools?\b/i,
  /\btechnical issues? with (?:the )?(?:file|tool)/i,
  /\bplease provide (?:the )?(?:source )?files?\b/i,
];

function classifyPage(page) {
  if (page && page._landing) return PAGE_PROFILES.landing;
  const pagePath = String(page && page.path || '').toLowerCase();
  if (pagePath === 'overview.md') return PAGE_PROFILES.overview;
  if (/^(?:architecture|reference)(?:\/|$)/.test(pagePath)) {
    return PAGE_PROFILES.architecture;
  }
  return PAGE_PROFILES.guide;
}

function proseWithoutFences(md) {
  const kept = [];
  let inFence = false;
  for (const line of String(md).split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

function pageStats(md) {
  const text = String(md);
  const prose = proseWithoutFences(text);
  const h1s = [...prose.matchAll(/^#\s+(.+?)\s*$/gm)]
    .map(match => match[1].replace(/\s+#+\s*$/, '').trim());
  const sections = (prose.match(/^##\s+/gm) || []).length;
  const mermaid = (text.match(/```mermaid\b/g) || []).length;
  const fences = (text.match(/^\s*```/gm) || []).length;
  const wordText = prose
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/[`*_>#|~-]/g, ' ');
  const words = wordText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];

  return {
    h1s,
    h1Count: h1s.length,
    sections,
    words: words.length,
    mermaid,
    fences,
    balancedFences: fences % 2 === 0,
  };
}

function addViolation(violations, code, message, target) {
  violations.push({
    code,
    ...(target === undefined ? {} : { target }),
    message,
  });
}

function markdownLinks(md) {
  const links = [];
  const regex = /\[([^\]]*)]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(String(md)))) {
    links.push({ label: match[1].trim(), target: match[2].trim() });
  }
  return links;
}

function validateCitationInventory(md, attached) {
  const block = String(md).match(/<cite>\s*([\s\S]*?)\s*<\/cite>/);
  if (!block) return false;
  const inventory = new Set(
    markdownLinks(block[1])
      .map(link => link.target.replace(/^file:\/\//, '').trim())
      .filter(target => !target.includes('#'))
  );
  return attached.every(file => inventory.has(file));
}

function validatePage(md, { page, attached = [], citationResult = {} }) {
  const text = String(md);
  const profile = classifyPage(page);
  const stats = pageStats(text);
  const violations = [...(citationResult.violations || [])];

  if (REFUSAL_PATTERNS.some(pattern => pattern.test(text))) {
    addViolation(
      violations,
      'refusal_text',
      'page contains refusal, apology, or file/tool access failure text'
    );
  }

  if (stats.h1Count !== 1) {
    addViolation(violations, 'h1_count', `expected exactly one H1, found ${stats.h1Count}`);
  } else if (stats.h1s[0] !== String(page.title).trim()) {
    addViolation(
      violations,
      'h1_title',
      `H1 must exactly match planned title "${page.title}"`
    );
  }

  const prose = proseWithoutFences(text);
  if (/(^|[\s([{:;,])``(?=$|[\s)\]}.,;:!?])/m.test(prose)) {
    addViolation(violations, 'empty_inline_code', 'page contains an empty inline code span');
  }

  if (stats.sections < profile.minSections || stats.sections > profile.maxSections) {
    addViolation(
      violations,
      'section_count',
      `${profile.name} pages require ${profile.minSections}-${profile.maxSections} H2 sections; found ${stats.sections}`
    );
  }

  if (stats.words < profile.minWords || stats.words > profile.maxWords) {
    addViolation(
      violations,
      'word_count',
      `${profile.name} pages require ${profile.minWords}-${profile.maxWords} words; found ${stats.words}`
    );
  }

  if (stats.mermaid > profile.maxMermaid) {
    addViolation(
      violations,
      'mermaid_count',
      `${profile.name} pages allow at most ${profile.maxMermaid} Mermaid diagrams; found ${stats.mermaid}`
    );
  }

  if (!stats.balancedFences) {
    addViolation(violations, 'unbalanced_fence', 'Markdown code fences are unbalanced');
  }

  if (attached.length && !validateCitationInventory(text, attached)) {
    addViolation(
      violations,
      'missing_cite',
      'top citation inventory must contain every attached source as a whole-file link'
    );
  }

  if (attached.length && !page._landing && !(citationResult.validRanges > 0)) {
    addViolation(
      violations,
      'missing_range_citation',
      'sourced non-landing pages require at least one valid section or diagram line range'
    );
  }

  if (page._landing) {
    const links = markdownLinks(text);
    for (const child of page._children || []) {
      const target = String(child.path).split('/').at(-1);
      const found = links.some(link => link.label === child.title && link.target === target);
      if (!found) {
        addViolation(
          violations,
          'landing_child_link',
          `landing page must link child "${child.title}" as "${target}"`,
          child.path
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    stats,
    profile,
  };
}

module.exports = {
  PAGE_PROFILES,
  classifyPage,
  pageStats,
  validatePage,
};
