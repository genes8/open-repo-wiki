'use strict';
/**
 * Prompt builders for the two pipeline stages (plan + page writing) and a
 * tolerant JSON extractor for model output.
 */

function planMessages(scan, opts) {
  const keyFileBlocks = Object.entries(scan.keyFiles)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n\n');
  const system =
    'You are a senior software architect who designs documentation wikis for code repositories. ' +
    'You respond with valid JSON only — no prose, no markdown fences.';
  const user = `Design a documentation wiki plan for the repository "${scan.name}".

Repository file tree:
${scan.tree}

Language statistics: ${scan.langStats || 'n/a'}

Key project files:
${keyFileBlocks || '(none found)'}

Return ONLY a JSON object with this exact shape:
{
  "pages": [
    {
      "path": "overview.md",
      "title": "Project Overview",
      "description": "one or two sentences describing what this page covers",
      "files": ["relative/path/one", "relative/path/two"]
    }
  ]
}

Rules:
- Between 4 and ${opts.maxPages} pages, scaled to repository size and complexity.
- The first page must be "overview.md" (high-level purpose, architecture, tech stack).
- Group deep topics into subdirectories, e.g. "architecture/data-flow.md", "guides/getting-started.md".
- Whenever a subdirectory holds 2 or more pages, also add a landing page named after the folder (e.g. "guides/guides.md", "architecture/architecture.md") that introduces and links its child pages. Give the landing page its own "files" list (the most representative sources for that group).
- "files" must list ONLY paths that appear in the file tree above — the most relevant source files for that page (max 12 per page).
- Cover: overview, architecture, main modules/features, configuration, and developer workflows where applicable.
- Add a dedicated page ONLY when the repository shows the signal for it: a testing guide if there is a test/spec directory or test config; a deployment/CI guide if there are Dockerfiles, compose files, or CI config; an API or CLI reference if there are documented endpoints or a CLI entry point (e.g. a "bin" field in package.json). Do not add these pages when the signal is absent.
- Do not invent files or features. JSON only.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function pageMessages(scan, page, filesBlock, opts) {
  const attached = opts.attached || [];
  const standard = (opts.template || 'standard') !== 'minimal';
  const citeList = attached.map(rel => `- [${rel}](${rel})`).join('\n');

  const system =
    'You are a precise technical writer producing repository wiki pages in GitHub-flavored Markdown. ' +
    'You only document what is visible in the provided source files — never invent APIs, options or behavior. ' +
    `Write in ${opts.language || 'English'}.`;

  // The citation template is only emitted when we actually attached files and the
  // standard template is active — this keeps every citation grounded in a real,
  // provided source (no hallucinated "Section sources" the way rigid templates cause).
  let templateBlock;
  if (standard && attached.length) {
    templateBlock = `
Document structure (follow this layout):
- Immediately after the H1, add this citation block verbatim (these are the only files you may cite):
<cite>
**Referenced Files in This Document**
${citeList}
</cite>
- If the page has 3 or more "##" sections, add a "## Table of Contents" with markdown anchor links right after the citation block.
- After each major "##" section that is grounded in source files, add a "**Section sources**" list citing ONLY the relevant files from the block above, formatted as "- [path](path)".
- After each mermaid diagram, add a "**Diagram sources**" list citing ONLY the relevant files from the block above.
- Cite ONLY paths from the citation block; never cite a file that is not listed. If a section is general guidance not tied to a specific file, simply omit its sources list — do not write placeholder text.`;
  } else if (attached.length) {
    templateBlock = '';
  } else {
    templateBlock = `
Document structure:
- No source files are attached — write from the tree and page focus only. Do NOT add a <cite> block or "Section sources": there is nothing concrete to cite.`;
  }

  const user = `Write the wiki page "${page.title}" for the repository "${scan.name}".

Page focus: ${page.description || page.title}

Repository file tree (for orientation):
${scan.tree}

Relevant source files:
${filesBlock || '(no source files attached — write from the tree and page focus only)'}

Requirements:
- Start with a single H1: "# ${page.title}".
- GitHub-flavored Markdown; use tables and fenced code blocks where useful.
- Use mermaid diagrams (\`\`\`mermaid) — "graph", "sequenceDiagram", or "flowchart" — when they genuinely clarify architecture or flow; recommended for architecture/data-flow pages, otherwise omit.
- Reference real file paths from the repository (inline code style).
- Be concrete and grounded in the shown code; do not speculate or pad.
- No front matter, no closing remarks, no "I" statements. Output the markdown document only.${templateBlock}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Descriptions for the structured knowledge cards generated per module. Each
// card is a focused, machine-consumable summary grounded strictly in the
// module's own source files.
const KNOWLEDGE_CARDS = {
  overview:
    'A concise overview of this module: its responsibility, boundary, and how it fits the wider repository.',
  architecture_design:
    'The internal architecture and design of this module: key components, their relationships, data flow, and notable patterns.',
  tech_stack:
    'The concrete technologies, runtimes, libraries and APIs this module uses, as evidenced by its source files.',
  coding_conventions:
    'The coding conventions observed in this module: naming, structure, error handling, and idioms actually used in the code.',
  unique_setup_and_commands:
    'Any setup steps, commands, environment variables or configuration unique to working with this module.',
};

function knowledgeMessages(scan, module, filesBlock, opts) {
  const card = opts.card;
  const focus = KNOWLEDGE_CARDS[card] || card;
  const system =
    'You are a senior engineer distilling a single repository module into a structured knowledge card. ' +
    'You document ONLY what is visible in the provided source files — never invent components, APIs or commands. ' +
    `Write in ${opts.language || 'English'}.`;
  const user = `Repository: "${scan.name}". Module: "${module.title}" (path: ${module.path || '(root)'}).

Card focus: ${focus}

Module scope (files that define this module):
${(module.scope || []).join('\n') || '(none)'}

Relevant source files:
${filesBlock || '(no source files attached)'}

Requirements:
- Output GitHub-flavored Markdown with no H1 title (the card file name is the title).
- Use short paragraphs or bullet lists; be concrete and grounded in the shown code.
- Reference real file paths (inline code style) where useful.
- If the module has nothing relevant for this card, output a single line: "_Not applicable for this module._"
- No front matter, no closing remarks, no "I" statements.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Models wrap JSON in fences or add prose around it — extract tolerantly.
function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error('model did not return parseable JSON');
}

module.exports = { planMessages, pageMessages, knowledgeMessages, KNOWLEDGE_CARDS, extractJson };
