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
  const profile = opts.profile || {
    name: 'guide',
    minSections: 3,
    maxSections: 6,
    minWords: 200,
    maxWords: 1100,
    maxMermaid: 1,
  };
  const standard = (opts.template || 'standard') !== 'minimal';
  const citeList = attached.map(rel => `- [${rel}](${rel})`).join('\n');
  const examplePath = attached[0];
  const exampleEnd = examplePath
    ? Math.max(1, Math.min(10, Number(opts.lineCounts && opts.lineCounts[examplePath]) || 1))
    : 1;
  const rangeExample = examplePath
    ? `- [${examplePath}:L1-L${exampleEnd}](${examplePath}#L1-L${exampleEnd})`
    : '';
  const childLinks = page._landing
    ? (page._children || [])
      .map(child => `- [${child.title}](${child.path.split('/').at(-1)})`)
      .join('\n')
    : '';
  const focus = `${page.description || page.title}${childLinks
    ? `\n\nThis is a landing page. Include every child using these exact links:\n${childLinks}`
    : ''}`;

  const system =
    'You are a precise technical writer producing repository wiki pages in GitHub-flavored Markdown. ' +
    'You only document what is visible in the provided source files — never invent APIs, options or behavior. ' +
    `Write in ${opts.language || 'English'}.`;

  let templateBlock;
  if (attached.length) {
    templateBlock = `
Grounded citation rules:
- Immediately after the H1, add this citation block verbatim (these are the only files you may cite):
<cite>
**Referenced Files in This Document**
${citeList}
</cite>
- Add a "**Section sources**" list after source-grounded major sections. Every entry must use an exact numbered range in this form:
${rangeExample}
- Add a "**Diagram sources**" ranged list after each Mermaid diagram.
- Choose ranges from the numbered source block. Never guess or exceed numbered source lines.
- Cite only attached paths. Keep the top <cite> entries as whole-file links without anchors.
- Include at least one valid ranged source entry on a non-landing page.
- If evidence does not support a section or diagram, omit it. Omit unsupported sections and diagrams instead of padding.${standard
    ? '\n- A Table of Contents is optional; if used as an H2, it counts toward the H2 limit.'
    : ''}`;
  } else {
    templateBlock = `
Grounded citation rules:
- No source files are attached. Do not add a <cite> block or structured source list.`;
  }

  const user = `Write the wiki page "${page.title}" for the repository "${scan.name}".

Page focus: ${focus}

Repository file tree (for orientation):
${scan.tree}

Relevant source files:
${filesBlock || '(no source files attached — write from the tree and page focus only)'}

Requirements:
- Start with a single H1: "# ${page.title}".
- Write ${profile.minSections}-${profile.maxSections} H2 sections and ${profile.minWords}-${profile.maxWords} words.
- Use at most ${profile.maxMermaid} Mermaid diagrams. A diagram is optional and must be supported by the attached sources.
- GitHub-flavored Markdown; use tables and fenced code blocks where useful.
- Reference real file paths from the repository (inline code style).
- Be concrete and grounded in the shown code; do not speculate or pad.
- Section names must fit the evidence; there is no fixed universal section skeleton.
- No front matter, no closing remarks, no "I" statements. Output the markdown document only.${templateBlock}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function repairPageMessages(scan, page, filesBlock, rejected, violations, opts) {
  const messages = pageMessages(scan, page, filesBlock, opts);
  const violationList = (violations || [])
    .map(item => `- ${item.code}: ${item.message}`)
    .join('\n');
  messages[0] = {
    ...messages[0],
    content: `${messages[0].content} You are repairing a rejected draft against deterministic validation errors.`,
  };
  messages[1] = {
    ...messages[1],
    content: `${messages[1].content}

The previous draft was rejected:
${violationList || '- invalid_output: the draft did not pass validation'}

<rejected_markdown>
${String(rejected)}
</rejected_markdown>

Return a complete replacement document that resolves every listed violation. Do not return a patch, explanation, or partial excerpt.`,
  };
  return messages;
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

function knowledgeMessages(scan, card, filesBlock, opts) {
  const focus = card.focus || KNOWLEDGE_CARDS[card.kind] || card.kind;
  const moduleLine = card.module
    ? ` Module: "${card.module.title}" (path: ${card.module.path || '(root)'}).`
    : '';
  const system =
    'You are a senior engineer distilling repository evidence into a structured knowledge card. ' +
    'You document ONLY what is visible in the provided source files — never invent components, APIs or commands. ' +
    `Write in ${opts.language || 'English'}.`;
  const user = `Repository: "${scan.name}".${moduleLine}

Card: "${card.name}" (${card.category}/${card.kind}).

Card focus: ${focus}

Card scope:
${(card.scope || []).join('\n') || '(none)'}

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

module.exports = {
  planMessages,
  pageMessages,
  repairPageMessages,
  knowledgeMessages,
  KNOWLEDGE_CARDS,
  extractJson,
};
