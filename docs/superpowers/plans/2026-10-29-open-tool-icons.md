# Open Tool Icons Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task;
> independent spec and code quality review follow implementation. Parent owns Git.

**Goal:** Finish open-string icon authoring and round trips under the approved v1 contract.

**Architecture:** Keep the existing wire reader and glyph map. Separate arbitrary
nonempty icon names from the known-glyph membership predicate at author/restore
boundaries. No renderer registry, dependencies or protocol changes.

**Tech Stack:** Existing TypeScript SDK, LangChain runtime and AG-UI view packages; pnpm/Vitest.

**Spec:** docs/superpowers/specs/2026-10-29-open-tool-icons-design.md.

## Task 1: Authoring and round trips

Files: packages/sdk/src/tool-display.ts, persisted-turn.ts and their existing test
and type-contract files; packages/ag-ui/src/view/step.ts, view/turns.ts and
matching tests. Audit permission-gate, capabilities/types and LangChain tool
conversion for additional closed membership checks. Avoid changing files that
already forward strings correctly.

- [x] Add failing top-level tests accepting display.icon='weather-radar' while
  rejecting '' and non-string values. Type-contract test must accept that name.
  Assert isToolDisplayIcon still recognizes only the recommended names, with
  compile-time narrowing tests for both true and false branches.
- [x] Run focused SDK tests to prove RED, then widen ToolDisplayIcon with known
  literal autocomplete and an open string alternative. Replace author validation
  with nonempty-string checks and update its error text/TSDoc. Keep the known-name
  predicate's runtime behavior and recommendation table stable; type its result
  as `value is (typeof TOOL_DISPLAY_ICONS)[number]`, preserving false-branch strings.
- [x] Add failing tests for custom icons in deprecated persisted/readStepEvent
  readers and permission restore projections, including constructor/__proto__.
  Verify actual RED before minimal nonempty-string pass-through changes.
- [x] Verify a real tool-display producer retains the custom name on running
  and settled v1 metadata, and a restored view retains it. Confirm generic glyph
  fallback is safe for unknown/prototype names without inventing a registry.
- [x] Run SDK, AG-UI, LangChain and affected core build/test/lint/typecheck. Build
  before dist-based tests. Review failures; do not weaken shared status fixtures.

## Task 2: Docs and delivery

Files: apps/web/content/docs/api/sdk.mdx, api/ag-ui.mdx, tool-authoring docs found
by rg, upgrading guidance if necessary; .changeset/<new-name>.md.

- [x] Explain open authoring names, ten recommended glyphs, known-name membership
  semantics and generic fallback. Remove claims that all icon names form a closed
  enum. Add a patch changeset, no manual package-version/release changes.
- [ ] Run pnpm lint, pnpm check:build-cache, pnpm build, pnpm typecheck, pnpm test,
  pnpm check:release-inventory and node scripts/check-docs.mjs. Run applicable
  release integrity/controller, packed consumer and harness checks; report any
  environmental limitations without claiming they passed.
- [ ] Independent spec review then quality review, final aggregate review; parent
  commits reviewed files, publishes and attaches a PR. Keep auto-merge off.

## Implementation evidence

Spec compliance and independent quality reviews approved the final four-boundary
implementation. Actual RED covered author validation, persisted reader, legacy/
permission projection and custom-name TypeScript acceptance. Added end-to-end
standard-event metadata/live-view and CLI discovery coverage. SDK 325, core 659,
LangChain 634, AG-UI 747 standard plus 185 Angular passed before the final added
outbound case (its complete focused suite: 14 passed). CLI discovery: 14 passed.
Affected builds/typechecks/lints passed, as did root lint, build-cache, docs check,
release integrity/inventory, pack checks and TypeScript packed-consumer probes.

Broad final verification and SEO regeneration follow the reviewed content commit.
Initial concurrent root runs encountered worker/loopback restrictions, a busy-host
sandbox shell timeout and stale SEO metadata. No unrelated source changes were
made for those failures; a direct unrestricted Inspector build passed.

Final whole-repository build passed sequentially (29 tasks); root typecheck also
passed. SEO metadata was regenerated after the content commit, updating exactly
the four touched doc routes, and both SEO checks passed. The full source run
reached an unchanged Docker-backed Hono setup timeout; the retry exposed the same
Docker fixture in Vercel deployment tests. Those attempts were stopped rather
than misreported as green. A scoped CLI/web rerun and remaining broad gates are
being recorded separately. No Docker or deployment test source was changed.
