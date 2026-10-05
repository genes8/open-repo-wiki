# Manual smoke checklist (F5)

Automated tests cover the pure logic; the items below verify the extension host
integration by pressing **F5** (Run Extension) from the `extension/` folder.

> Step 5 (install from `.vsix`) is user-run: the CI/agent path verifies compile,
> tests, and packaging only.

1. **Extension host launches** — no activation error in the Output / Debug
   console; the "Repo Wiki" activity-bar icon appears.
2. **Empty workspace shows welcome + Generate** — with no `.local-wiki/`
   catalog, the "Wiki Pages" view shows the welcome content with a
   `Generate Wiki` link.
3. **Generate against a small repo** — with a mock or real config, running
   Generate shows progress in the notification and the tree fills with pages.
4. **Page click opens preview** — clicking a page opens the preview with
   rendered mermaid diagrams and syntax-highlighted code blocks.
5. **🔒 on manually edited page after regen** — edit a generated page by hand,
   regenerate, and confirm the page keeps the 🔒 protected badge and the edit is
   not overwritten.
6. **modifyPage supplement flow** — run Modify Page, pick a page and
   `Supplement`, enter an instruction, and confirm the page is updated and
   marked curated.
7. **editPlan scaffold** — run Edit wiki_plan.yaml in a workspace without one;
   the file is created and opened.
8. **selectModel quick pick** — run Select Model Profile; the quick pick lists
   the engine's model profiles and selecting one updates `defaultModel`.
9. **exportPdf without deps** — on an engine without `playwright`/`pdf-lib`,
   run Export to PDF and confirm the guidance message appears.
10. **Save a dependent file → status-bar hint** — edit and save a source file
    referenced by a wiki page; a status-bar hint appears (or generation runs
    automatically when `autoUpdate` is `auto`).
