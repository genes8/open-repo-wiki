'use strict';

// Output-side citation guard (defense-in-depth).
//
// buildFilesBlock already filters the INPUT (only real, attached files ever
// reach the prompt). This guards the OUTPUT: a disobedient model could still
// write a "Section sources"/"<cite>" entry pointing at a path we never
// attached. We strip any such structured citation so the rendered page can
// only cite files that were genuinely provided to it.
//
// Scope is deliberately narrow — only the structured citation lists are
// enforced:
//   - the `<cite> ... </cite>` block, and
//   - `**Section sources**` / `**Diagram sources**` bullet lists.
// Free-form inline prose links are intentionally NOT rewritten: they cannot be
// safely distinguished from legitimate wiki-internal links (e.g. a landing
// page linking `[Configuration](configuration.md)`), so touching them would
// break real navigation for no guaranteed gain.

// Normalize a link target to a repo-relative path for set membership:
// drop a file:// scheme and any #Lx-Ly anchor, then trim.
function normTarget(p) {
  return String(p).replace(/^file:\/\//, '').replace(/#.*$/, '').trim();
}

// Matches a markdown bullet whose first link target we capture, e.g.
//   - [generate.js](generate.js)
//   - [scan.js](lib/scan.js#L1-L20)
const ITEM_RE = /^\s*-\s*\[[^\]]*\]\(([^)]+)\)/;

function sanitizeCitations(md, attached) {
  const allowed = new Set((attached || []).map(normTarget));
  const lines = String(md).split('\n');
  const out = [];
  let dropped = 0;
  let inCite = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*<cite>\s*$/.test(line)) { inCite = true; out.push(line); i++; continue; }
    if (/^\s*<\/cite>\s*$/.test(line)) { inCite = false; out.push(line); i++; continue; }

    if (inCite) {
      const m = line.match(ITEM_RE);
      if (m && !allowed.has(normTarget(m[1]))) { dropped++; i++; continue; }
      out.push(line); i++; continue;
    }

    // A "Section sources" / "Diagram sources" marker followed by a contiguous
    // bullet list. Keep only allowed entries; if none survive, drop the whole
    // (now meaningless) marker too.
    if (/^\s*\*\*(?:Section|Diagram) sources\*\*\s*$/.test(line)) {
      let j = i + 1;
      const kept = [];
      while (j < lines.length) {
        const im = lines[j].match(ITEM_RE);
        if (!im) break;
        if (allowed.has(normTarget(im[1]))) kept.push(lines[j]);
        else dropped++;
        j++;
      }
      if (kept.length) {
        out.push(line, ...kept);
      } else {
        dropped++; // the orphaned marker itself
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return { md: out.join('\n'), dropped };
}

module.exports = { sanitizeCitations, normTarget };
