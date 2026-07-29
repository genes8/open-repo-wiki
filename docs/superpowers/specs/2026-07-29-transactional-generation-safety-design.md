# Transactional Generation Safety Design

**Date:** 2026-07-29
**Status:** Approved

## Context

The current generator accepts any normalized planner response with at least the
required overview page and at most `maxPages`. It then writes successful pages
directly into the live wiki, preserves an old file only when the same page path
fails, and deletes every previously managed path omitted by the newest plan.
Stale cleanup runs even when one or more pages failed.

A real generation exposed the combined failure mode:

- the planner returned a usable but low-coverage six-page plan where the prior
  wiki had fifteen content pages;
- two planned pages failed deterministic quality validation;
- four pages were published directly;
- twelve prior pages omitted by the new plan were deleted;
- the command exited non-zero only after content, state, catalog, and index had
  already changed.

The same run also published a testing page that ended mid-sentence and contained
an unsupported shell command. Existing gates validate structure, word counts,
citations, and Markdown integrity, but not provider truncation metadata or
source evidence for commands.

## Goals

1. Treat a generation run as one transaction: content, catalog, state, index,
   and requested knowledge output become live together only after every required
   artifact validates.
2. Guarantee that page or knowledge failure leaves the live wiki byte-for-byte
   unchanged.
3. Detect and retry suspicious plan regressions before page generation.
4. Require explicit authority before deleting previously managed pages.
5. Persist enough run evidence to diagnose failed planner and page attempts.
6. Reject singleton directory structures and landings with fewer than two
   children.
7. Reject truncated completions and shell commands not grounded in attached
   source text.
8. Preserve source-hash incremental generation and support legacy state/catalog
   output.

## Non-goals

- General factual verification of every prose sentence.
- Using another LLM to grade generated output.
- Changing the public default content, meta, knowledge, or PDF export paths.
- Introducing a database or external service.
- Automatically recovering deleted Markdown from old PDF/HTML exports.
- Making multiple directory renames instantaneously invisible to concurrent
  readers. The required guarantee is all-or-rollback publication, not a new
  virtual filesystem layer.

## Considered Approaches

### Staged snapshot plus backup rename

Build the complete next state in sibling staging directories. After validation,
rename each live target to a backup, rename each stage into place, and roll back
all already-swapped targets if any commit step fails.

This preserves existing paths, works with the exporter, keeps staging on the
same filesystem as each live target, and provides a deterministic rollback
boundary. This is the selected approach.

### In-place writes plus rollback journal

Copy each file before overwriting it and replay the journal on failure. This is
smaller initially but vulnerable to process termination between mutation and
journal completion. It also makes directory cleanup and catalog/state
consistency harder to reason about.

### Immutable release directories plus `current` symlink

Write each run to a versioned directory and atomically update one symlink. This
offers the cleanest read-side atomicity, but changes output paths, complicates
Windows behavior, and breaks current exporter assumptions.

## Command-line Semantics

Two explicit deletion flags are introduced:

- `--prune` permits stale managed pages to be removed only after the new plan
  passes normal regression checks and the whole run succeeds.
- `--accept-plan-shrink` bypasses plan-regression checks and implies stale-page
  deletion after the whole run succeeds.
- With neither flag, omitted prior pages and their metadata are carried into the
  staged snapshot. New output replaces matching paths, but no prior managed page
  is removed.

`--pages` remains a selective regeneration filter. It is incompatible with
`--prune` and `--accept-plan-shrink`, because a partial run cannot safely prove
that omitted paths are stale. The CLI must reject either combination before
calling a model or creating staging directories.

`--force` affects source-hash skipping but does not weaken plan or publication
gates.

`--dry-run` runs planner retries and validation, writes run diagnostics, prints
the accepted plan, and never creates publication staging targets.

## Component Boundaries

### `lib/plan-quality.js`

Owns plan-level policy:

- derives the previous successful plan from state, falling back to catalog;
- classifies stable topic keys from normalized path/title text;
- detects page-count regression;
- detects loss of previously covered key topics;
- detects singleton directories;
- detects explicit or synthetic landings with fewer than two children;
- returns structured violations rather than mutating output.

The page-count threshold is a 25% loss:

```text
new page count < ceil(previous page count * 0.75)
```

The threshold is disabled when there is no prior successful plan or when
`--accept-plan-shrink` is present.

Topic comparison uses deterministic keys:

- `overview`
- `architecture`
- `modules`
- `configuration`
- `testing`
- `guides`
- `reference`
- `providers`
- `prompts`
- `scanning`
- `installation`
- `usage`
- `export`
- `deployment`

Only a key present in the previous successful plan is required in the next plan.
Page-count regression remains the broad protection against many narrow pages
being collapsed into one generic page with the same category key.

### `lib/run-transaction.js`

Owns filesystem publication:

- validates every managed target;
- creates one sibling stage and backup path per live target;
- copies the complete existing live tree into its stage;
- exposes stage paths to the orchestrator;
- commits all requested targets with backup renames;
- rolls back already-swapped targets in reverse order on commit failure;
- removes stages and backups after success or abort;
- never follows a symlinked target or parent.

The transaction handles:

- content directory, including `index.md` and `.state.json`;
- meta directory, including `catalog.json`;
- knowledge locale directory only when knowledge generation was requested.

Copying the live tree first preserves unmanaged files. Managed stale files are
removed only inside the stage and only when deletion authority is present.

### `lib/run-diagnostics.js`

Owns immutable diagnostic artifacts under:

```text
<local-wiki-root>/runs/<run-id>/
```

It uses atomic file writes and safe relative paths. It never stores API keys,
authorization headers, `.env` contents, or full source prompts.

Artifacts:

```text
run.json
plan/attempt-1.raw.txt
plan/attempt-1.json
plan/attempt-2.raw.txt
plan/attempt-2.json
plan/accepted.normalized.json
pages/<encoded-page-path>/attempt-1.md
pages/<encoded-page-path>/attempt-1.json
pages/<encoded-page-path>/attempt-2.md
pages/<encoded-page-path>/attempt-2.json
```

Each attempt JSON records:

- model profile and provider model name;
- finish reason;
- token usage when returned;
- sanitizer violations;
- quality violations;
- page statistics;
- accepted/rejected status.

`run.json` records flags, timestamps, final status (`committed`, `aborted`, or
`dry-run`), accepted plan summary, page/knowledge failure counts, and the
published commit phase when relevant.

### `lib/providers.js`

Adds a detailed completion API:

```js
chatDetailed(profile, messages, opts) -> {
  content,
  finishReason,
  usage
}
```

- OpenAI-compatible providers use `choices[0].finish_reason` and response
  `usage`.
- Ollama uses `done_reason` and available prompt/eval counters.
- llama.cpp returns `finishReason: "stop"` when the library provides no richer
  metadata and `usage: null`.

The existing `chat()` wrapper remains for compatibility and returns only
`content`. The generator uses `chatDetailed()` for both planning and page/card
generation.

### `lib/quality.js`

Extends deterministic page validation:

- `completion_truncated` when finish reason is `length`, `max_tokens`, or an
  equivalent provider-specific limit;
- `incomplete_ending` when the trimmed document ends with an unterminated prose
  token rather than terminal punctuation or a complete Markdown construct;
- `incomplete_final_section` when the final H2 contains fewer than twenty prose
  words and does not contain a complete table, code block, or at least two list
  entries;
- `ungrounded_command` for each executable line in `bash`, `sh`, `shell`,
  `console`, or `zsh` fences whose whitespace-normalized text does not occur in
  any attached raw source.

Comments, blank lines, output lines prefixed with a configured prompt marker,
and continuation-only lines are ignored when extracting commands. A shell fence
with no attached source is rejected.

Page prompts state that shell commands may be emitted only when they appear
verbatim in the numbered source block. Planner repair is responsible for adding
manifest, README, or script files required to ground command-oriented pages.

### `lib/plan.js`

Continues to sanitize, deduplicate, cap, and annotate normalized pages.
Structural plan validation runs after every normalization pass:

- a non-root directory must contain either zero pages or at least two
  non-landing pages;
- a landing is valid only with at least two children;
- explicit one-child landings are violations rather than accepted landings;
- hard-cap recomputation must not create an invalid one-child group.

These errors are returned to planner repair. They do not silently flatten or
invent a sibling topic.

### `generate.js`

Remains the orchestrator but no longer owns low-level transaction, diagnostic,
or plan-quality policy.

## Run Data Flow

### 1. Initialize diagnostics

Resolve arguments and output roots, validate incompatible flags, scan the
repository, create a run ID, and persist the initial `run.json`.

### 2. Plan with bounded repair

For at most three attempts:

1. request a plan with `chatDetailed`;
2. persist raw output and provider metadata;
3. parse and normalize;
4. evaluate structure, count regression, and topic regression;
5. accept, or call a repair prompt containing prior-plan summary and exact
   violation codes.

Three rejected attempts abort before publication staging.

### 3. Create complete staged snapshot

Create stage copies for content and meta. Add knowledge only when requested.
Load state and metadata from the staged copy, but keep all state changes in
memory until artifact writes target the stage.

When deletion is not authorized, merge previous published metadata/pages into
the accepted plan for publication and navigation. When deletion is authorized,
remove omitted managed paths only from the stage.

### 4. Generate children and landing pages

For each page:

- copy or keep unchanged staged content when its source hash matches;
- otherwise call `chatDetailed`;
- persist every draft and validation result;
- repair at most twice;
- write only validated Markdown to the staged path;
- update next state only after the staged page write succeeds.

Landing pages still run after children and use successfully staged child
metadata.

### 5. Generate derived output

Write staged catalog, staged index, and staged state. If knowledge was
requested, generate all cards into the staged knowledge target and require every
card to pass.

### 6. Commit or abort

If any page/card/derived-output operation failed:

- mark diagnostics `aborted`;
- delete stage targets;
- leave all live targets unchanged;
- return non-zero.

If everything passed:

- commit target swaps with backups;
- roll back on any rename failure;
- mark diagnostics `committed`;
- return zero.

## Incremental and Legacy Behavior

The state schema advances to version 3 and stores:

- source-backed per-page hashes;
- last successfully published page metadata;
- last successful normalized plan;
- last committed run ID.

Legacy schema-2 state is accepted. The first run derives the previous plan from
`pageMetadata`, then from `catalog.json` if needed. Legacy data is upgraded only
inside staging and becomes live only after successful commit.

An unchanged page is not sent to the model. Its live Markdown and metadata are
already present in the copied stage snapshot.

## Error and Recovery Rules

- Planner exhaustion: no stage, live untouched, diagnostics retained.
- Page or knowledge exhaustion: stage deleted, live untouched, diagnostics
  retained.
- Stale cleanup error: transaction aborts before commit.
- Commit rename error: restore backups in reverse order; report rollback errors
  separately and retain diagnostics.
- Diagnostic-write error before commit: abort the run, because a run without
  required evidence does not meet the design.
- Cleanup failure after a successful swap is reported, but does not roll back a
  fully committed live result unless a backup is still required for recovery.

## Test Strategy

### Plan quality unit tests

- 15 pages collapsing to 6 produces `plan_page_regression`.
- exactly 25% loss is allowed; more than 25% is rejected.
- missing prior topic produces `plan_topic_regression`.
- `--accept-plan-shrink` bypasses count/topic regression only.
- singleton directory produces `plan_singleton_directory`.
- one-child landing produces `plan_landing_children`.
- valid two-child landing passes.

### Transaction unit tests

- staging starts as a byte-identical live snapshot;
- abort removes stages and leaves live trees unchanged;
- successful commit replaces every target and removes backups;
- a forced second-target rename failure restores the first target;
- unsafe and symlink-parent targets are rejected.

### Provider and semantic-quality unit tests

- OpenAI and Ollama response metadata map to the detailed result;
- legacy `chat()` still returns content;
- length-limited completion is rejected;
- mid-sentence final text is rejected;
- a short but complete final list/table is accepted;
- exact source-backed shell command passes;
- incorrect or unattached command fails.

### End-to-end integration tests

- page failure leaves content, state, catalog, index, and knowledge byte-identical;
- knowledge failure leaves page output byte-identical;
- plan collapse retries three times and aborts before staging;
- a repaired second plan proceeds;
- default successful run retains omitted pages;
- `--prune` deletes omitted pages after a non-regressive successful run;
- `--accept-plan-shrink` accepts a regressive plan and deletes omitted pages;
- incompatible selective/deletion flags fail before model calls;
- failed attempts preserve raw plans, drafts, violations, and finish reasons;
- successful output contains no staging or backup directories.

## Acceptance Mapping

| Requirement | Authoritative evidence |
|---|---|
| Transactional whole run | Integration snapshot hashes before/after forced page and knowledge failures |
| No stale cleanup on failure | Same snapshots plus absence of deletion log/metadata mutation |
| Plan regression retry | Mock planner attempt count, violation artifacts, unchanged live tree |
| Explicit deletion only | Default, `--prune`, and `--accept-plan-shrink` integration cases |
| Persistent diagnostics | Run-directory artifact assertions for failed and successful attempts |
| Reject singleton/weak landing | Plan-quality unit tests and repaired-plan integration case |
| Semantic quality | Provider metadata and command/truncation unit plus integration tests |

The implementation is complete only when every row has direct passing evidence
and the full existing suite remains green.
