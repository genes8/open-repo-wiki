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
- "files" must list ONLY paths that appear in the file tree above — the most relevant source files for that page (max 12 per page).
- Cover: overview, architecture, main modules/features, configuration, and developer workflows where applicable.
- Do not invent files or features. JSON only.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function pageMessages(scan, page, filesBlock, opts) {
  const system =
    'You are a precise technical writer producing repository wiki pages in GitHub-flavored Markdown. ' +
    'You only document what is visible in the provided source files — never invent APIs, options or behavior. ' +
    `Write in ${opts.language || 'English'}.`;
  const user = `Write the wiki page "${page.title}" for the repository "${scan.name}".

Page focus: ${page.description || page.title}

Repository file tree (for orientation):
${scan.tree}

Relevant source files:
${filesBlock || '(no source files attached — write from the tree and page focus only)'}

Requirements:
- Start with a single H1: "# ${page.title}".
- GitHub-flavored Markdown; use tables and fenced code blocks where useful.
- Add a mermaid diagram (\`\`\`mermaid) when it genuinely clarifies architecture or flow — otherwise omit it.
- Reference real file paths from the repository (inline code style).
- Be concrete and grounded in the shown code; do not speculate or pad.
- No front matter, no closing remarks, no "I" statements. Output the markdown document only.`;
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

module.exports = { planMessages, pageMessages, extractJson };
