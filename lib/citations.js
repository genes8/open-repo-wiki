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

// Normalize a link target to a repo-relative path for set membership.
function normTarget(p) {
  return String(p).replace(/^file:\/\//, '').replace(/#.*$/, '').trim();
}

function parseRangeTarget(target) {
  const match = String(target).match(/^(?:file:\/\/)?([^#]+)#L(\d+)-L(\d+)$/);
  return match ? {
    path: match[1].trim(),
    start: Number(match[2]),
    end: Number(match[3]),
  } : null;
}

const BULLET_RE = /^\s*-\s+/;
const LINK_RE = /\[[^\]]*]\(([^)]+)\)/g;

function citationItem(line) {
  if (!BULLET_RE.test(line)) return null;
  const targets = [...String(line).matchAll(LINK_RE)].map(match => match[1]);
  return {
    target: targets.length === 1 ? targets[0] : null,
    linkCount: targets.length,
  };
}

function violation(code, target, message) {
  return { code, target: String(target), message };
}

function sanitizeCitations(md, attached, lineCounts = {}) {
  const allowed = new Set((attached || []).map(normTarget));
  const lines = String(md).split('\n');
  const out = [];
  const violations = [];
  let dropped = 0;
  let validRanges = 0;
  let inCite = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*<cite>\s*$/.test(line)) { inCite = true; out.push(line); i++; continue; }
    if (/^\s*<\/cite>\s*$/.test(line)) { inCite = false; out.push(line); i++; continue; }

    if (inCite) {
      const item = citationItem(line);
      if (item) {
        if (!item.target) {
          violations.push(violation(
            'citation_item_format',
            line,
            `structured citation bullets require exactly one Markdown link; found ${item.linkCount}`
          ));
          dropped++;
          i++;
          continue;
        }
        const target = item.target;
        const normalized = normTarget(target);
        if (!allowed.has(normalized)) {
          violations.push(violation(
            'citation_unattached',
            target,
            `citation path "${normalized}" was not attached`
          ));
          dropped++;
          i++;
          continue;
        }
        if (String(target).includes('#')) {
          violations.push(violation(
            'citation_inventory_format',
            target,
            'top citation inventory entries must use whole-file links'
          ));
          dropped++;
          i++;
          continue;
        }
      }
      out.push(line); i++; continue;
    }

    // A "Section sources" / "Diagram sources" marker followed by a contiguous
    // bullet list. Keep only allowed entries; if none survive, drop the whole
    // (now meaningless) marker too.
    if (/^\s*\*\*(?:Section|Diagram) sources\*\*\s*$/.test(line)) {
      let j = i + 1;
      const spacing = [];
      while (j < lines.length && /^\s*$/.test(lines[j])) {
        spacing.push(lines[j]);
        j++;
      }
      const kept = [];
      while (j < lines.length && BULLET_RE.test(lines[j])) {
        const item = citationItem(lines[j]);
        if (!item.target) {
          violations.push(violation(
            'citation_item_format',
            lines[j],
            `structured citation bullets require exactly one Markdown link; found ${item.linkCount}`
          ));
          dropped++;
          j++;
          continue;
        }
        const target = item.target;
        const parsed = parseRangeTarget(target);
        const normalized = parsed ? normTarget(parsed.path) : normTarget(target);

        if (!allowed.has(normalized)) {
          violations.push(violation(
            'citation_unattached',
            target,
            `citation path "${normalized}" was not attached`
          ));
          dropped++;
        } else if (!parsed) {
          violations.push(violation(
            'citation_range_format',
            target,
            'section and diagram citations must use #Lx-Ly'
          ));
          dropped++;
        } else if (parsed.start < 1 || parsed.end < parsed.start) {
          violations.push(violation(
            'citation_range_order',
            target,
            'citation range must satisfy 1 <= start <= end'
          ));
          dropped++;
        } else if (!Number.isInteger(lineCounts[normalized])
          || parsed.end > lineCounts[normalized]) {
          violations.push(violation(
            'citation_range_bounds',
            target,
            `citation range exceeds the ${lineCounts[normalized] || 0} source lines`
          ));
          dropped++;
        } else {
          kept.push(lines[j]);
          validRanges++;
        }
        j++;
      }
      if (kept.length) {
        out.push(line, ...spacing, ...kept);
      } else {
        dropped++;
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return { md: out.join('\n'), dropped, violations, validRanges };
}

module.exports = { sanitizeCitations, normTarget, parseRangeTarget };
