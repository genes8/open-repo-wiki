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

function hasRefusalText(text) {
  return REFUSAL_PATTERNS.some(pattern => pattern.test(String(text)));
}

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

function normalizeEvidence(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function shellCommands(md) {
  const commands = [];
  const pattern = /```(?:bash|sh|shell|console|zsh)\s*\n([\s\S]*?)```/gi;
  for (const match of String(md).matchAll(pattern)) {
    for (const raw of match[1].split('\n')) {
      const line = raw.trim().replace(/^(?:\$|>)\s+/, '');
      if (!line || line.startsWith('#') || line === '\\') continue;
      commands.push(line.replace(/\\\s*$/, '').trim());
    }
  }
  return commands.filter(Boolean);
}

function withoutStructuredCitations(md) {
  const withoutInventory = String(md).replace(/<cite>\s*[\s\S]*?\s*<\/cite>/gi, '');
  const kept = [];
  let skipping = false;
  for (const line of withoutInventory.split('\n')) {
    if (/^\s*\*\*(?:Section|Diagram) sources\*\*\s*:?\s*$/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!line.trim() || /^\s*-\s+\[[^\]]+]\([^)]+\)\s*$/.test(line)) continue;
      skipping = false;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function finalSectionAnalysis(md) {
  const cleaned = withoutStructuredCitations(md);
  const headings = [...cleaned.matchAll(/^##\s+.+$/gm)];
  if (!headings.length) {
    return { structuralContent: false, terminalComplete: false };
  }
  const last = headings.at(-1);
  const body = cleaned.slice(last.index + last[0].length).trim();
  if (!body) return { structuralContent: false, terminalComplete: false };

  const closesFence = /```\s*$/.test(body) && (body.match(/^\s*```/gm) || []).length % 2 === 0;
  const tableLines = body.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line));
  const hasTable = tableLines.length >= 2
    && tableLines.some(line => /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(line));
  const listItems = body.split('\n').filter(line => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line));
  const prose = proseWithoutFences(body)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*]\([^)]+\)/g, ' ');
  const proseWords = prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  const structuralContent = proseWords.length >= 20
    || closesFence
    || hasTable
    || listItems.length >= 2;
  const terminalComplete = closesFence || /[.!?;:)\]}>|`]$/.test(body);
  return { structuralContent, terminalComplete };
}

function finalSectionIsComplete(md) {
  const analysis = finalSectionAnalysis(md);
  return analysis.structuralContent && analysis.terminalComplete;
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

function validatePage(md, {
  page,
  attached = [],
  citationResult = {},
  completion = {},
  rawByPath = {},
}) {
  const text = String(md);
  const profile = classifyPage(page);
  const stats = pageStats(text);
  const violations = [...(citationResult.violations || [])];

  if (hasRefusalText(text)) {
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

  if (/^(?:length|max_tokens|token_limit)$/i.test(String(completion.finishReason || ''))) {
    addViolation(
      violations,
      'completion_truncated',
      `provider reported a truncated completion (${completion.finishReason})`
    );
  }

  const finalSection = finalSectionAnalysis(text);
  if (!finalSection.terminalComplete) {
    addViolation(
      violations,
      'incomplete_ending',
      'final H2 section ends without terminal punctuation or a complete Markdown construct'
    );
  }
  if (!finalSection.structuralContent) {
    addViolation(
      violations,
      'incomplete_final_section',
      'final H2 section needs at least 20 prose words or a complete fence, table, or two-item list'
    );
  }

  const sourceEvidence = attached.map(file => normalizeEvidence(rawByPath[file] || ''));
  for (const command of shellCommands(text)) {
    const normalized = normalizeEvidence(command);
    if (normalized && !sourceEvidence.some(source => source.includes(normalized))) {
      addViolation(
        violations,
        'ungrounded_command',
        `shell command is not present in attached source evidence: ${command}`,
        command
      );
    }
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
  finalSectionIsComplete,
  hasRefusalText,
  normalizeEvidence,
  pageStats,
  shellCommands,
  validatePage,
};
