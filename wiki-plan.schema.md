# wiki_plan schema

A `wiki_plan.yaml` file (Qoder `wiki_plan.yaml` parity) pre-declares what a wiki
should look like before the model plans or writes anything. It lets you pin the
page list, inject guidance notes, pick a template preset, and constrain the
source files the generator considers — deterministically, instead of hoping the
planner picks the right structure.

## File locations

| Detail | Value |
|---|---|
| Preferred name | `wiki_plan.yaml` (repo root) |
| Alternative | `wiki_plan.json` (repo root) |
| Precedence | `wiki_plan.yaml` wins if both exist |
| Absent | No plan file → the model plans freely (normal mode) |
| Committed | Yes — this is source-controlled intent, not machine state |

`loadWikiPlan()` checks `<repo>/wiki_plan.yaml` first, then
`<repo>/wiki_plan.json`, and returns `null` when neither exists. The file is
read once at the start of a run, alongside `repo-wiki.config.json`.

## Schema

Every field, with its type and default:

| Path | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `version` | int | no | `1` | Must be exactly `1` (integer, or the YAML string `"1"`). Anything else is an error. |
| `repowiki` | map | no | `{}` | Page plan, guidance notes, and template preset. |
| `repowiki.template` | string | no | `""` | One of `""`, `"architecture"`, `"product_requirement"` (see [Template presets](#template-presets)). |
| `repowiki.notes` | list | no | `[]` | Guidance notes injected into planning and page-writing prompts (see [Notes](#notes-injection-points)). |
| `repowiki.documents` | list | no | `[]` | Fixed page list. When non-empty, the generator enters **strict documents mode** (see below). |
| `repowiki.documents[].title` | string | **yes** | — | Non-empty, unique across the list. |
| `repowiki.documents[].goal` | string | no | `""` | One–two sentence page description. |
| `repowiki.documents[].parent` | string | no | `""` | Title of the top-level document this page nests under. |
| `repowiki.documents[].hints` | string | no | `""` | Author hints added to the page prompt. |
| `knowledgecard` | map | no | `{}` | Knowledge-card layer options. |
| `knowledgecard.notes` | list | no | `[]` | Guidance notes injected into knowledge-card prompts. |
| `scope` | map | no | `{}` | Source-file allow/deny globs (see [Scope globs](#scope-globs)). |
| `scope.include` | list&lt;string&gt; | no | `[]` | Allowlist globs; empty means "everything". |
| `scope.exclude` | list&lt;string&gt; | no | `[]` | Deny globs; always applied. |

A **note** entry is either a plain string or a map:

| Note field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `text` | string | **yes** | — | The note body (non-empty). |
| `author` | string | no | `""` | Optional attribution. |

### Example

```yaml
# guidance for the wiki generator
version: 1

repowiki:
  template: "architecture"
  notes:
    - text: "Focus on business workflows"
      author: "enes"
    - text: "Target new engineers"
  documents:
    - title: "System Architecture Overview"
      goal: "Describe modules and interactions"
    - title: "Order System"
      goal: "Explain the order lifecycle"
      parent: "System Architecture Overview"
      hints: "Include the payment flow"

knowledgecard:
  notes:
    - text: "Focus on payment and order modules"

scope:
  include:
    - "src/**"
  exclude:
    - "**/test/**"
```

The equivalent `wiki_plan.json` is the same structure as JSON:

```json
{
  "version": 1,
  "repowiki": {
    "template": "architecture",
    "notes": [{ "text": "Focus on business workflows", "author": "enes" }],
    "documents": [
      { "title": "System Architecture Overview", "goal": "Describe modules and interactions" },
      { "title": "Order System", "parent": "System Architecture Overview" }
    ]
  },
  "knowledgecard": { "notes": [] },
  "scope": { "include": ["src/**"], "exclude": ["**/test/**"] }
}
```

## Template presets

`repowiki.template` selects a preset that is spliced into the planning and
page-writing prompts. An empty value injects nothing.

| Value | Planning preset | Page preset |
|---|---|---|
| `""` (default) | none — the model plans freely | none |
| `architecture` | organize the wiki as a comprehensive technical analysis — module boundaries, data flow, dependencies, and internal APIs | favor technical depth — module boundaries, data flow, dependencies |
| `product_requirement` | organize the wiki around product requirements and user-facing capabilities rather than internal code structure | frame content around user-facing capabilities and requirements |

The presets are prompt-level guidance only: they shape what the model writes but
never override the deterministic validation or coverage rules.

## Notes injection points

Notes are rendered as an `Author guidance:` block and appended to the relevant
prompt, exactly as written (quoted, with optional `author`):

- `repowiki.notes` → the **planning prompt** (normal mode) and the **page-writing
  prompt** for every page.
- `repowiki.notes` → the **file-assignment prompt** in strict documents mode
  (the only model call that happens there).
- `knowledgecard.notes` → the **knowledge-card prompts** (only when the
  `--knowledge` / `knowledge: true` layer is enabled).

Notes never alter validation: a note cannot relax citation, section, or coverage
requirements.

## Strict documents mode

When `repowiki.documents` is non-empty, the page list is **fixed by the file** —
the model never adds, removes, renames, or reorders pages. The only model call is
a single file-assignment step (up to 3 attempts): assign each document the most
relevant source files (max 12 per page) from the scanned tree.

Rules that hold in strict mode:

- **Deterministic layout.** Page paths are derived from titles, not model output:
  - A parent document with children → `<slug>/<slug>.md` landing page plus
    `<slug>/<child-slug>.md` for each child.
  - A parentless document → `<slug>.md` at the content root.
  - Slugs are the title, lowercased, non-alphanumerics removed, whitespace →
    `-`; the result is sanitized into a valid relative path. Titles that
    collide after slugification are rejected.
- **One-level parents.** A `parent` must name a top-level document (one that has
  no `parent` of its own). Grandchild chains are rejected.
- **No duplicate titles.** Every `title` must be unique, and no document may be
  its own parent.
- **LLM only assigns files.** The model's response is just a
  `{ "documents": [{ "title", "files" }] }` map; titles are echoed back exactly.
- **Coverage still applies.** After assignment, the same deterministic coverage
  pass runs: every coverable source file (code files, not data/docs) is appended
  to the most relevant page unless `config.ensureCoverage` is `false`.
- **No `overview.md` requirement.** Strict mode does not force an `overview.md`
  page; the document list is authoritative.
- **Requires an explicit regenerate.** Because the plan is file-driven, changing
  the wiki structure means editing `wiki_plan.yaml` and running
  `node generate.js <repo>` again. A normal re-run skips unchanged pages; use
  `--prune` to delete managed pages that are no longer in the document list.

## Scope globs

`scope.include` / `scope.exclude` are gitignore-flavored globs applied to the
finished scan (before planning). Both may be used together.

- `include` (when non-empty) is an **allowlist**: a file must match at least one
  include pattern.
- `exclude` is always a **deny**: a file matching any exclude pattern is removed.
- A file survives only if it is not excluded **and** (when include is non-empty)
  is included.

Pattern semantics (gitignore wins where gitignore and shell globs differ):

| Pattern feature | Meaning |
|---|---|
| `*` | matches any run of characters within a single path segment |
| `**` | matches any number of full path segments (zero or more) |
| leading `/` | anchors the first segment to the repo root |
| trailing `/` | directory prefix — matches the directory itself and everything under it |
| no `/` in the body (e.g. `src/`, `*.md`) | unanchored; may match at any directory depth |
| body contains `/` | root-relative unless it begins with `**` (whose prefix re-covers any depth) |

Examples:

| Pattern | Matches |
|---|---|
| `src/**` | everything under `src/` |
| `**/test/**` | anything under any `test` directory at any depth |
| `/package.json` | only the root `package.json` |
| `src/` | any `src` directory at any depth, and everything under it |
| `*.md` | any `.md` file at any depth |

If the scope filters the scan down to zero files, the run aborts with
`empty_scope` — the generator refuses to plan an empty wiki.

## Parser limitations (strict subset)

`wiki_plan.yaml` is parsed by a strict, zero-dependency YAML subset parser, not a
full YAML library. Accepted syntax:

- nested maps, string scalars, lists of strings, and lists of maps with string
  fields.
- `#` comments (quote-aware: a `#` inside a quoted string is not a comment).
- empty flow collections `[]` and `{}` as shorthands.

Rejected with a line number:

- **Tabs** — indentation must be spaces.
- **Anchors and aliases** (`&anchor` / `*alias`).
- **Flow maps / flow sequences with content** (e.g. `[a, b]` or `{k: v}`) —
  only the empty `[]` and `{}` forms are accepted.
- **Quoted strings with escapes** — double-quoted strings may not contain `\"`;
  single quotes are taken literally. Unterminated quotes are an error.
- **Multi-line scalars** (block scalars `|` / `>`).
- **Duplicate keys**, including duplicates inside a list item's map.
- **Prototype-pollution keys** — `__proto__`, `constructor`, `prototype`.
- **One-level documents** — a document whose parent already has a parent is a
  grandchild and is rejected.
- Unknown top-level keys, wrong scalar types, and any value that is not a string
  where a string is expected.

`wiki_plan.json` skips the YAML subset parser and is read with `JSON.parse`,
then run through the same schema validation (so field errors are reported as
`wiki_plan: ...` without a YAML line number).

## Validation errors and line numbers

YAML schema and syntax errors are reported as:

```text
wiki_plan.yaml line <N>: <message>
```

For example: `wiki_plan.yaml line 4: unknown top-level key "bogus"`, or
`wiki_plan.yaml line 7: repowiki.template must be one of: "", "architecture",
"product_requirement"`. Errors that are not tied to a specific line (for
example, JSON parse failures) are prefixed `wiki_plan:`. At the CLI, a bad plan
file surfaces as an `ApiError` with code `bad_plan_file` and aborts the run.
