# Wiki Quality and Grounding Design

## Context

`open-repo-wiki` already grounds page generation in attached repository files, filters structured citations, writes a catalog and knowledge layer, and skips pages whose source-backed generation hash has not changed. A comparison with Qoder RepoWiki showed five material gaps:

1. generated output has only a minimal length check and can accept refusal text, shallow pages, invalid citations, or damaged Markdown;
2. landing pages exist only when the LLM planner obeys the landing instruction;
3. source citations do not carry verified line ranges;
4. page depth is inconsistent, while a rigid universal template would encourage padding and hallucination;
5. knowledge cards use mechanical module names and have no topical-card deduplication or generated-file manifest.

The implementation must close those gaps without replacing source-hash incremental generation, adopting Qoder's invalid `file://` links, forcing unsupported sections, or overwriting the user's existing dirty-worktree changes.

## Goals

- Reject or repair low-quality page output before it reaches the wiki.
- Preserve literal inline `<think>...</think>` examples while still removing a model's leading reasoning block.
- Guarantee a landing page for every final directory containing at least two non-landing pages.
- Emit source-section and diagram citations with line ranges validated against the attached files.
- Generate pages with bounded, topic-appropriate depth rather than one universal section skeleton.
- Produce semantically named, source-grounded, deduplicated module and topical knowledge cards.
- Preserve last-known-good output and the existing source-content hash incremental behavior.
- Cover new behavior with deterministic `node:test` tests and an end-to-end mock-provider smoke test.

## Non-goals

- Reproduce Qoder's ten-section template or diagram density.
- Add Git-based regeneration as a replacement for source hashes.
- Add a plugin system, provider registry, Anthropic integration, or other unrelated architecture.
- Validate arbitrary free-form prose links. Validation remains scoped to generated citation structures and generated landing links.
- Delete files that are not explicitly recorded as generator-managed outputs.

## Chosen architecture

The implementation extracts deterministic policies from `generate.js` into small CommonJS modules:

- `lib/plan.js` owns plan normalization, validation, stable ordering, landing synthesis, and parent relationships.
- `lib/quality.js` owns page profiles, output validation, and machine-readable violations.
- `lib/citations.js` continues to own citation sanitization and gains strict range parsing and bounds validation.
- `lib/knowledge.js` owns knowledge-card planning, topical-signal detection, stable identities, frontmatter, and manifest-based stale cleanup.
- `lib/prompts.js` owns page-depth instructions, line-aware citation instructions, and repair prompts.
- `generate.js` remains the orchestrator: scan, plan, normalize, attach sources, generate/repair, atomically publish, update state, catalog, index, and knowledge output.

This keeps policy independently testable and prevents `generate.js` from becoming the only place where every behavior is encoded.

## Plan normalization and guaranteed landings

`normalizePlan(rawPages, scan, { maxPages })` will:

1. sanitize paths and reject entries without a usable path or title;
2. preserve the first occurrence of a normalized path and stable planner order;
3. filter every planned `files` list to real `scan.fileSet` entries;
4. require `overview.md` to exist and remain first;
5. recognize `dir/dir.md` and `dir/index.md` as explicit landing pages;
6. synthesize a landing for every directory with at least two non-landing pages and no explicit landing;
7. populate synthetic landing sources from the stable union of child sources, capped at six files;
8. populate `_children`, `_landing`, and original description metadata used by generation and catalog output;
9. enforce `maxPages` as a hard final cap.

To preserve the cap, normalization repeatedly removes the last non-overview content page while the content pages plus required landings exceed `maxPages`, then recomputes which landings are required. The final invariant is: every directory that still has at least two content pages has exactly one landing, and total generated pages do not exceed `maxPages`.

Landing pages are generated after their children. Their prompt contains the exact final child titles and relative links. The quality gate rejects a landing that omits any expected child link. Catalog `parent` values are derived from the normalized plan, not reconstructed from untrusted planner output.

## Source blocks and line-range citations

`buildFilesBlock` will retain raw source content for hashing while presenting numbered lines to the model:

```text
--- lib/providers.js ---
L1: 'use strict';
L2: ...
```

The canonical range citation is:

```markdown
- [lib/providers.js:L11-L23](lib/providers.js#L11-L23)
```

Repository-relative paths are retained for exporter portability. `file://` is not introduced.

Citation behavior is split by context:

- the top `<cite>` block remains a validated whole-file inventory;
- `**Section sources**` and `**Diagram sources**` entries require `#Lx-Ly`;
- the path must be attached to the page;
- `1 <= x <= y <= actualLineCount` must hold;
- invalid paths, malformed anchors, reversed ranges, and out-of-bounds ranges are dropped and returned as validation violations;
- an empty structured source marker is removed.

The sanitizer does not silently clamp or invent a valid range. Its violation list is given to the repair prompt so the model must produce a grounded replacement.

## Page depth profiles

Pages are classified deterministically from normalized metadata:

| Profile | Section range | Word range | Mermaid maximum |
|---|---:|---:|---:|
| Landing | 2–4 H2 sections | 120–700 | 1 |
| Guide/default | 3–6 H2 sections | 200–1,100 | 1 |
| Overview | 4–7 H2 sections | 280–1,400 | 2 |
| Architecture/reference | 4–8 H2 sections | 300–1,600 | 3 |

The prompt describes these bounds and offers evidence-driven section examples, but it never requires fixed section names. Architecture pages are encouraged to use one useful diagram, but no profile has a minimum diagram count: unsupported diagrams must be omitted.

The quality gate checks the bounds, but not a universal skeleton. This makes short refusal/stub output invalid while allowing each page to reflect its actual sources.

## Quality gates and repair flow

`validatePage(md, context)` returns `{ ok, violations, stats }`. Violations have stable codes and readable messages. Validation covers:

- exactly one H1 matching the planned title;
- refusal/apology/tool-failure phrases;
- empty inline-code spans;
- profile word and H2-section bounds;
- maximum Mermaid count;
- balanced Markdown fences;
- the expected top citation inventory when sources are attached;
- at least one valid line-range citation on a sourced non-landing page;
- only attached source paths in structured citations;
- all expected child links on landing pages.

`generate.js` makes one normal generation attempt and up to two targeted repair attempts. A repair prompt includes:

- the original page request and attached, line-numbered sources;
- the rejected Markdown;
- the exact violation codes and messages;
- an instruction to return a complete replacement document, not a patch.

Only validated Markdown is written. State is updated only after a successful atomic write. If all attempts fail:

- any existing page and its previous state hash remain untouched;
- no placeholder or apology page is written;
- the page is counted as failed;
- the process exits non-zero after processing the remaining pages.

## Safe reasoning-block removal

`stripThink` will remove only one or more complete `<think>...</think>` blocks occurring at the beginning of a provider response, before any non-whitespace answer content. Literal tags later in the response—including inline-code documentation examples—remain unchanged.

The function becomes exported for direct regression testing. An all-reasoning response still becomes empty and follows the existing empty-completion error path.

## Incremental-state compatibility

Source-content hashes remain authoritative for regeneration. The page hash continues to include model, language, template, title, description, and hashes of attached raw source files.

A constant generation schema version is added to the hash inputs. Changing citation syntax, quality rules, depth profiles, or landing normalization can bump this version so existing pages are not incorrectly skipped after generator behavior changes.

Failed validation never stores the new hash. A later run therefore retries the page. A successful unchanged second run still logs `SKIP`.

## Semantic and deduplicated knowledge layer

The existing five module-card kinds remain:

- `overview`
- `architecture_design`
- `tech_stack`
- `coding_conventions`
- `unique_setup_and_commands`

Common directory names receive deterministic semantic titles, including `lib` → `Core Libraries`, `src` → `Application Source`, and `test`/`tests` → `Test Suite`; unknown names fall back to `titleCase`. The root module keeps the repository name and description-derived context.

Cross-cutting topical cards are planned only when repository evidence exists:

- configuration system: config files or environment-profile handling;
- error handling: `try`, `catch`, `throw`, or explicit error paths;
- logging system: console or logger calls;
- dependency management: supported package/lock manifests.

Every planned card has a stable identity composed from category, module/topic key, normalized scope, and sorted source files. Duplicate identities are removed before any model call. Only one topical card per detected category is generated.

Every Markdown knowledge card receives YAML frontmatter with:

- `kind`
- `category`
- `name`
- `scope`
- `source_files`

Module `_index.yaml` and `_module.yaml` files remain. A `_manifest.json` records generator-managed knowledge files. At the end of a successful knowledge pass, files present in the previous manifest but absent from the new manifest are removed; user-created files not listed in the manifest are never deleted.

Knowledge prompts use the same source-grounding rules and refusal checks. Duplicate or invalid cards fail the knowledge pass rather than being published.

## Testing strategy

The project will use Node's built-in test runner and add:

- `test/providers.test.js`: leading reasoning removal and preservation of inline literal tags;
- `test/plan.test.js`: invalid paths/files, deduplication, hard cap, explicit landing recognition, synthesized landings, and parent invariants;
- `test/citations.test.js`: valid ranges, missing second `L`, reversed/out-of-bounds ranges, unattached files, and whole-file top citations;
- `test/quality.test.js`: refusal text, empty code spans, depth profiles, citation coverage, fence balance, diagram bounds, and landing child links;
- `test/knowledge.test.js`: semantic titles, topical signal detection, stable deduplication, frontmatter, manifest cleanup, and preservation of unmanaged files;
- `test/generate.integration.test.js`: an isolated temporary repository and mock provider covering repair, atomic last-known-good preservation, landing synthesis, valid catalog relationships, line-range citations, knowledge output, and a second-run `SKIP`.

`test/mock-llm.js` will support an ephemeral port and deterministic bad-then-good responses so integration tests do not need network access or a fixed port.

## Error handling and observability

Quality failures log the page, attempt number, and stable violation codes. Citation drops log their reason counts. Knowledge deduplication logs planned, skipped duplicate, generated, and failed counts. No source content or API key is included in diagnostic output.

The existing batch behavior remains: independent pages continue after a failure, final exit status is non-zero if any page or required knowledge card fails.

## Acceptance criteria

The implementation is accepted only when fresh evidence proves all of the following:

1. Inline `<think>` documentation survives while a leading reasoning block is removed.
2. A planner response with grouped child pages and no landings produces valid synthetic landings, child links, catalog parents, and a hard-cap-compliant final plan.
3. Every generated section/diagram citation has an attached path and in-bounds `#Lx-Ly` range.
4. Refusal, malformed, shallow, excessively padded, or citation-invalid pages are repaired or rejected without overwriting last-known-good output.
5. Page prompts and output satisfy profile-specific depth bounds without a fixed universal section skeleton or forced diagrams.
6. Knowledge output uses semantic module titles, includes grounded topical cards only when signaled, carries frontmatter, contains no duplicate identities, cleans stale managed files, and preserves unmanaged files.
7. The generation hash still reacts to raw source changes and skips an unchanged second run.
8. `npm test`, syntax checks, and the full mock-provider integration test pass from the isolated feature worktree.
9. The original dirty worktree retains the user's pre-existing `.env`, config, and generator edits without being folded into feature commits.
