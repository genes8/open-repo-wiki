'use strict';
/**
 * Prompt builders for the two pipeline stages (plan + page writing) and a
 * tolerant JSON extractor for model output.
 */

// Qoder wiki_plan parity: guidance notes and template presets injected into
// the planning and writing prompts.
function notesBlock(notes, heading) {
  if (!notes || !notes.length) return '';
  const lines = notes.map(n => `- ${JSON.stringify(n.text)}${n.author ? ` (author: ${JSON.stringify(n.author)})` : ''}`);
  return `\n${heading}:\n${lines.join('\n')}\n`;
}

const TEMPLATE_PRESETS = {
  architecture: {
    plan: 'Template preset "architecture": organize the wiki as a comprehensive technical analysis — module boundaries, data flow, dependencies, and internal APIs.',
    page: 'Template preset "architecture": favor technical depth — module boundaries, data flow, dependencies.',
  },
  product_requirement: {
    plan: 'Template preset "product_requirement": organize the wiki around product requirements and user-facing capabilities rather than internal code structure.',
    page: 'Template preset "product_requirement": frame content around user-facing capabilities and requirements.',
  },
};

function planMessages(scan, opts) {
  const keyFileBlocks = Object.entries(scan.keyFiles)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n\n');
  const minPages = opts.minPages || 4;
  // Anchoring the plan on previously published pages keeps paths/titles stable
  // across runs (LLM planners are non-deterministic), which prevents needless
  // regeneration and destructive stale-page cleanup after cosmetic re-plans.
  const priorBlock = (opts.priorPages || []).length
    ? `\nA previous version of this wiki was already published with these pages:\n${
      opts.priorPages.map(p => `- ${p.path} ("${p.title}")`).join('\n')
    }\nReuse the exact same "path" and "title" for every topic that still exists in the repository. Only add pages for new material and only drop pages whose subject was removed.\n`
    : '';
  const guidanceBlock = [
    opts.notesBlock ? String(opts.notesBlock).trim() : '',
    opts.templatePreset ? String(opts.templatePreset).trim() : '',
  ].filter(Boolean).join('\n\n');
  const system =
    'You are a senior software architect who designs documentation wikis for code repositories. ' +
    'You respond with valid JSON only — no prose, no markdown fences.';
  const user = `Design a documentation wiki plan for the repository "${scan.name}".

Repository file tree:
${scan.tree}

Language statistics: ${scan.langStats || 'n/a'}

Key project files:
${keyFileBlocks || '(none found)'}
${priorBlock}${guidanceBlock ? `\n${guidanceBlock}\n` : ''}
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
- Between ${minPages} and ${opts.maxPages} pages, scaled to repository size and complexity.
- The first page must be "overview.md" (high-level purpose, architecture, tech stack).
- Group deep topics into subdirectories, e.g. "architecture/data-flow.md", "guides/getting-started.md".
- Whenever a subdirectory holds 2 or more pages, also add a landing page named after the folder (e.g. "guides/guides.md", "architecture/architecture.md") that introduces and links its child pages. Give the landing page its own "files" list (the most representative sources for that group).
- "files" must list ONLY paths that appear in the file tree above — the most relevant source files for that page (max 12 per page).
- Every source-code file in the tree must appear in the "files" list of at least one page. Give each substantial module its own page (or a shared page within its directory); never leave a lesser-known file undocumented just because it seems minor.
- Cover: overview, architecture, main modules/features, configuration, and developer workflows where applicable.
- Add a dedicated page ONLY when the repository shows the signal for it: a testing guide if there is a test/spec directory or test config; a deployment/CI guide if there are Dockerfiles, compose files, or CI config; an API or CLI reference if there are documented endpoints or a CLI entry point (e.g. a "bin" field in package.json). Do not add these pages when the signal is absent.
- Do not invent files or features. JSON only.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function repairPlanMessages(scan, previousPages, rejected, violations, opts) {
  const messages = planMessages(scan, opts);
  const previous = (previousPages || [])
    .map(page => `- ${page.path}: ${page.title}`)
    .join('\n');
  const violationList = (violations || [])
    .map(item => `- ${item.code}: ${item.message}`)
    .join('\n');
  messages[0] = {
    ...messages[0],
    content: `${messages[0].content} You are repairing a rejected wiki plan against deterministic validation errors.`,
  };
  messages[1] = {
    ...messages[1],
    content: `${messages[1].content}

The previous successful wiki covered:
${previous || '(no previous pages)'}

The rejected plan failed:
${violationList || '- invalid_plan: the plan did not pass validation'}

<rejected_plan>
${String(rejected)}
</rejected_plan>

Return a complete replacement JSON plan that resolves every listed violation. Do not return a patch, explanation, or Markdown.`,
  };
  return messages;
}

function assignFilesMessages(scan, documents, opts = {}) {
  const system = 'You are a senior software architect assigning source files to documentation pages. You respond with valid JSON only — no prose, no markdown fences.';
  const user = `Assign the most relevant source files to each documentation page for the repository "${scan.name}".

Repository file tree:
${scan.tree}

Language statistics: ${scan.langStats || 'n/a'}
${notesBlock(opts.notes, 'Author guidance')}
Pages (fixed — do not add, remove, or rename):
${documents.map(d => `- title: ${JSON.stringify(d.title)}${d.goal ? `, goal: ${JSON.stringify(d.goal)}` : ''}${d.hints ? `, hints: ${JSON.stringify(d.hints)}` : ''}`).join('\n')}

Return ONLY a JSON object:
{
  "documents": [
    { "title": "<exact title from the list>", "files": ["relative/path", "..."] }
  ]
}

Rules:
- Echo the page titles exactly as given, one entry per page, same order.
- "files" must list ONLY paths from the file tree above, max 12 per page.
- Every source-code file in the tree must appear in at least one page's "files".
- Do not invent files. JSON only.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
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
  const guidanceBlock = [
    opts.notesBlock ? String(opts.notesBlock).trim() : '',
    opts.templatePreset ? String(opts.templatePreset).trim() : '',
  ].filter(Boolean).join('\n\n');
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
    : ''}${opts.hints ? `\nAuthor hints: ${opts.hints}\n` : ''}`;

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
- Shell commands may appear only when the exact command text is visible in the numbered source block. Do not infer or repair commands from general knowledge.
- Section names must fit the evidence; there is no fixed universal section skeleton.
- No front matter, no closing remarks, no "I" statements. Output the markdown document only.${templateBlock}${guidanceBlock ? `\n${guidanceBlock}\n` : ''}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function repairPageMessages(scan, page, filesBlock, rejected, violations, opts) {
  // Deliberately NOT a re-run of pageMessages: repeating the full authoring
  // prompt around a rejected draft makes small models rewrite from scratch and
  // regress (observed: 1 violation escalating to 5 across attempts). Instead we
  // frame a minimal-edit task: the draft is the primary artifact, the fixes are
  // an explicit checklist, and the constraints are restated compactly.
  const attached = opts.attached || [];
  const profile = opts.profile || { minSections: 3, maxSections: 6, minWords: 200, maxWords: 1100, maxMermaid: 1 };
  const lineCounts = opts.lineCounts || {};
  const violationList = (violations || [])
    .map(item => `- ${item.code}: ${item.message}`)
    .join('\n') || '- invalid_output: the draft did not pass validation';
  const rangeInventory = attached
    .map(rel => `- ${rel} (lines 1-${Math.max(1, Number(lineCounts[rel]) || 1)})`)
    .join('\n');
  const childLinks = page._landing
    ? (page._children || [])
      .map(child => `- [${child.title}](${child.path.split('/').at(-1)})`)
      .join('\n')
    : '';

  const system =
    'You are a precise technical editor repairing a rejected repository wiki page. ' +
    'You make the smallest edit that fixes the listed validation errors and keep every valid part unchanged. ' +
    'You only document what is visible in the provided source files. ' +
    `Write in ${opts.language || 'English'}.`;

  const constraints = [
    `- Exactly one H1, verbatim: "# ${page.title}".`,
    `- ${profile.minSections}-${profile.maxSections} H2 sections and ${profile.minWords}-${profile.maxWords} words.`,
    `- At most ${profile.maxMermaid} Mermaid diagrams.`,
    attached.length
      ? '- Immediately after the H1, keep this citation block verbatim:\n<cite>\n**Referenced Files in This Document**\n'
        + attached.map(rel => `- [${rel}](${rel})`).join('\n')
        + '\n</cite>'
      : '- No <cite> block (no files are attached).',
    attached.length && !page._landing
      ? '- At least one "**Section sources**" bullet with an exact range like '
        + `"- [${attached[0]}:L1-L2](${attached[0]}#L1-L2)" within the valid line windows below.`
      : null,
    childLinks ? `- Keep these exact child links:\n${childLinks}` : null,
    '- No apologies, no meta commentary, no front matter.',
  ].filter(Boolean).join('\n');

  const user = `The draft below for the wiki page "${page.title}" (repository "${scan.name}") was rejected.

Validation errors — fix ONLY these, change nothing else:
${violationList}

Constraints that must hold after the edit:
${constraints}
${attached.length ? `\nValid citation line windows:\n${rangeInventory}\n` : ''}
<rejected_markdown>
${String(rejected)}
</rejected_markdown>
${filesBlock ? `\nSource files (for citation ranges and facts only):\n${filesBlock}\n` : ''}
Return the complete corrected Markdown document only — not a patch, not an explanation.`;

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
- No front matter, no closing remarks, no "I" statements.${notesBlock(opts.notes, 'Author guidance')}`;
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
  repairPlanMessages,
  pageMessages,
  repairPageMessages,
  knowledgeMessages,
  KNOWLEDGE_CARDS,
  notesBlock,
  TEMPLATE_PRESETS,
  assignFilesMessages,
  extractJson,
};
