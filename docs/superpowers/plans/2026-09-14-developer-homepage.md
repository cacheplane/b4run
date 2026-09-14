# Developer Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in this session. Use independent review at the evidence and final UI checkpoints. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved code-led homepage using a genuine recorded CLI repair and inspectable framework/blueprint source.

**Architecture:** Curated, committed evidence supplies server-rendered code and proof. Small client components handle local walkthrough and capability selections. The Next.js page composes these sections with existing site chrome and SEO, using scoped Paper Relay styles.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript, Shiki, CSS Modules, Vitest/jsdom, and the available browser automation tools. No new runtime dependency or model calls.

**Spec:** [Developer homepage design](../specs/2026-09-14-developer-homepage-design.md).

**Approved execution preference:** Continue inline in this worktree. Branch is
`blove/developer-homepage`, based on merged blueprint commit `91619fa6`. Preserve
ignored recordings and visual studies; do not remove this worktree during delivery.

## File map

All paths below are repository-relative. Always execute commands from the root.

| Path | Responsibility |
|---|---|
| `apps/web/app/components/homepage/evidence.json` | Curated source, selected observations, provenance, and verdicts |
| `apps/web/app/components/homepage/evidence.ts` | Typed evidence contract, validation, exact snippets, display values |
| `apps/web/app/components/homepage/evidence.test.ts` | Evidence integrity, redaction, source/diff/outcome invariants |
| `apps/web/scripts/export-homepage-evidence.mjs` | Maintainer-only bounded export from the local recording and pinned Git source |
| `apps/web/app/components/homepage/highlight.ts` | Server-only Shiki preparation of code/diff panels |
| `apps/web/app/components/homepage/CodePanel.tsx` | Selectable code, explicit folding, exact copying, source link |
| `apps/web/app/components/homepage/Walkthrough.tsx` | Recorded step/file selection; initial verification state |
| `apps/web/app/components/homepage/Capabilities.tsx` | Capability selector with actual source excerpts |
| `apps/web/app/components/homepage/DeveloperHome.tsx` | Server page composition, copy, project map, run command |
| `apps/web/app/components/homepage/homepage.module.css` | Scoped Paper Relay component styling and responsive layout |
| `apps/web/app/components/homepage/homepage.test.tsx` | SSR, interactive, clipboard, and escaped-text behavior |
| `apps/web/app/page.tsx` | Replace old homepage composition, retain metadata and JSON-LD |
| `apps/web/app/components/HeaderInner.tsx` | Homepage-only header variant, existing navigation preserved |
| `apps/web/app/components/homepage/header.module.css` | Homepage header color/CTA treatment without docs changes |
| `apps/web/app/seo/registry.ts` | Homepage title/description only |
| `apps/web/app/opengraph-image.tsx` | Root social image using approved identity/headline |
| `apps/web/app/seo/seo.test.ts` | Homepage metadata consistency alongside existing coverage |
| `apps/web/app/seo/lastmod.generated.json` | Regenerate using the existing script when required |

Existing `app/layout.tsx`, `Footer.tsx`, global tokens, and docs layout remain
unchanged unless a demonstrated integration requirement needs a tightly scoped
fix. Do not migrate fonts globally; use the existing Inter/JetBrains variables
in the new module. Do not remove Fraunces from routes outside this scope.

## Task 1: Curated evidence and reproducible source

- [x] Read the selected recording and report. Confirm UUID
  `90532f93-a8b9-43ff-9d94-b664a37af813`, clean source, live mode, approval pending,
  duration 113145ms, and the four named checks. Capture its report-pinned hash.
- [x] Define the evidence contract in `evidence.ts`: version, run ID, original
  recording hash, agent commit, source-link commit, image and fixture identity,
  timings, all six criteria, suite receipts, exact selected command results,
  original/repaired CLI source, complete displayed source files, and excerpts
  identified by file plus start/end lines. Use readonly types; optional fields
  are omitted rather than assigned undefined.
- [x] Write integrity tests first. Mutations must fail for `live: false`, dirty
  provenance, a false criterion, a missing named check, an edited source excerpt,
  a changed original/repaired diff, or an approval-completed claim. Include a
  source string containing `<script>` as data to exercise later escaping.
- [x] Run `pnpm --filter @b4run/web exec vitest run --config vitest.config.ts app/components/homepage/evidence.test.ts`.
  Confirm failure because the contract/export does not yet exist.
- [x] Implement `export-homepage-evidence.mjs` with `--recording` and `--output`.
  Use an explicit allowlist of output fields, not a recursive dump of the run.
  Accept only the selected successful live receipt with expected identity/hash.
  Load original fixture and capability source using `git show <recorded-sha>:<path>`
  without executing it. Copy the recorded agent/config/plan text directly.
  Capture visible failure and passing results from actual run tool results.
  Preserve omitted observation boundaries as labeled highlights.
- [x] For stable source links, verify repository source snapshots and capability files are byte-equal at merged
  commit `91619fa68522079087f09e9ead792b30a09bd6de`; use that commit for links while
  preserving `cbe93c9b`'s full recorded commit in provenance. Record SHA-256 per
  complete source file and ensure each snippet equals its selected line range.
  The agent-repaired `src/cli.ts` is recording evidence, not a merged repository
  source file; link its provenance to the curated evidence, never to a pristine
  fixture file as though that were the repair. Generate a normal line diff from
  original/repaired source. Do not substitute
  the reference patch or rewrite source around prettier demo text.
- [x] Export the bounded document:

  ```sh
  node apps/web/scripts/export-homepage-evidence.mjs --recording artifacts/code-fixer/recordings/cli-flags-final-gpt5.json --output apps/web/app/components/homepage/evidence.json
  ```

  Expected: one curated JSON document, no environment or conversation fields.
  The exporter refuses overwrite without an explicit `--replace` flag and never
  changes the original recording. Review the JSON for secrets/host paths and
  unnecessary fields before committing. CI reads the committed document only.
- [x] Implement pure validation and display selectors. Keep all failure criteria
  strict; a missing source is an error, not fallback demo content. Test duration
  rounding and exact model-override labeling.
- [x] Run the evidence test again; expect pass. Request independent evidence
  review against the original receipt and pinned source. Fix material findings.
- [x] Commit evidence, exporter, contract, and tests.

## Task 2: Server-rendered code and recorded walkthrough

- [x] Read existing `apps/web/lib/shiki/highlight-light.ts` and
  `apps/web/app/components/ui/CodeFrame.tsx`. Reuse applicable server highlighter
  setup. Add a dark Paper Relay theme in `homepage/highlight.ts` using installed
  Shiki; keep it server-only. No browser highlighter bundle.
- [x] Write meaningful `homepage.test.tsx` coverage using the existing React DOM
  and jsdom patterns: SSR contains agent source and 1+3 passing receipts before
  hydration; selected state is Verify + review; no “approved” or “exported” success.
  Test source text with markup characters is inert, not executed or injected.
- [x] Run `pnpm --filter @b4run/web exec vitest run --config vitest.config.ts app/components/homepage/homepage.test.tsx`;
  confirm the expected missing-component failure.
- [x] Implement `CodePanel` with full underlying source, prepared highlighted
  lines, file metadata, source-link URL, and optional instruction-fold range.
  Folding hides only a contiguous instruction range and shows a labeled native
  button. Copy uses full source; catch clipboard failure and show a polite error.
  Displayed line numbers preserve original positions and are excluded from copying.
- [x] Implement the walkthrough data flow:

  ```ts
  type Step = "reproduce" | "repair" | "verify"
  type SourceFile = "agent" | "config" | "plan"
  // Initial values are deterministic for SSR and hydration.
  const [step, setStep] = useState<Step>("verify")
  const [file, setFile] = useState<SourceFile>("agent")
  ```

  Pre-render all required code variants server-side and pass serializable values
  to the client island. Native buttons use `aria-pressed`. File selection does
  not reset step selection. Source highlighting follows the selected step only
  where relevant; never change source text. Result DOM precedes code DOM for
  mobile/screen readers; desktop CSS places code on the left.
- [x] Implement selected failure/patch/test/approval presentations from evidence.
  Label edited highlights and total recorded duration; never simulate streaming
  or playback. Use escaped React text for command output. Include the historical
  fixture qualifier near the walkthrough even when supporting copy is brief.
- [x] Extend tests to select all steps/files, expand/collapse instructions, copy
  exact source, deny clipboard, and preserve independent section state. Use
  `react-dom/client`, `act`, and DOM selectors; no new testing library is required.
- [x] Run both homepage test files; expect pass. Commit the walkthrough.

## Task 3: Code-led capabilities and page composition

- [x] Implement `Capabilities` with Workspaces, Sandboxes (default), Evals, and
  Approval. Each selection renders its pinned source range and one sentence
  from the spec. Source links open complete files. Evals code uses `runEval`/
  `defineEval`; distinguish blueprint checks from built-in framework behavior.
- [x] Cover capability switching and state independence in `homepage.test.tsx`.
  Assert the sandbox policy is initial HTML and switching capabilities does not
  reset the walkthrough. Verify excerpts equal the evidence selector output.
- [x] Compose `DeveloperHome`: hero, walkthrough, capabilities, project map,
  run section. Keep exactly one h1 and structured heading order. Import the
  composition from `page.tsx`, preserving its SEO resolution and JSON-LD.
- [x] Implement scoped `homepage.module.css`: paper surface, ink display,
  Relay selection, dark code, restrained rules. Start at 13–14px code; stack
  before labels become cramped. No horizontal document overflow at 320px.
  Use a static dot only if it clears text at all widths. Hide it on narrow screens.
- [x] Use this exact run command, with setup context and README link:

  ```sh
  B4_CODE_FIXER_MODEL=gpt-5 pnpm --filter @b4-example/code-fixer-server run:agent -- --task cli-flags
  ```

  State Node 24, pnpm, Docker, and host API key prerequisites. Mention replay in
  one sentence and link to the retained report. Do not imply the command works
  before dependency installation, package build, and fixture image preparation.
- [x] Implement the header's pathname-specific homepage class and blueprint CTA.
  Retain Docs/Blog/GitHub/mobile links and the existing height. For mobile, keep
  the existing accessible menu; changing its destination set is unnecessary.
  Test header behavior for `/` and `/docs/getting-started` with mocked pathname.
- [x] Run web tests, lint, and typecheck. Commit composition and styles.

## Task 4: Homepage metadata and social card

- [x] Update only the homepage entry in `seo/registry.ts`: title
  “B4.run — Ridiculous speed. Readable code.” and a plain description about TypeScript
  agents with tools, workspaces, sandbox execution, and approval. Respect existing
  metadata title templating. Preserve all canonical and structured-data fields.
- [x] Update the root `opengraph-image.tsx` to the approved Paper Relay identity
  and headline using the actual logo assets. Retain 1200×630 output, image route
  exports, and existing font/asset loading conventions. Article-specific social
  image routes remain unchanged. Inspect actual generated output.
- [x] Extend existing SEO tests for homepage title/description, canonical URL,
  one WebPage JSON-LD record, and social image dimensions. Do not lock decorative
  pixel coordinates in unit tests.
- [x] Run `pnpm --filter @b4run/web seo:lastmod` if the generator reports changed
  source dependencies; review its diff. Then run `pnpm --filter @b4run/web
  seo:lastmod:check` and the web tests. Commit SEO updates.

## Task 5: Rendered review, validation, and PR

- [x] Run `pnpm build` before any consumer of workspace `dist` output. Run
  `pnpm --filter @b4run/web lint`, `pnpm --filter @b4run/web typecheck`,
  `pnpm --filter @b4run/web test`, and `pnpm --filter @b4run/web seo:audit-built`.
  All must pass; inspect any build-generated files before committing.
- [x] Start `pnpm --filter @b4run/web dev --port 59620` if that port is free;
  otherwise choose a free port and record it. Use the browser tools and applicable
  browser skill to inspect the real route, not the inline study.
- [x] At 320, 390, 768, and 1280px: verify no document overflow, readable code,
  working selection, result-first mobile order, focus, touch target sizes,
  clipboard failure, and functioning external links. At 200% zoom and reduced
  motion, ensure all content remains available. Verify no-JS initial content
  includes the correct evidence and source. Save review screenshots locally.
- [x] Inspect `/docs/getting-started`, the mobile docs menu, and one blog page for
  unintended chrome/token changes. Inspect the generated root social image.
- [x] Request independent final review of evidence handling, SSR/hydration,
  accessibility, homepage scope, and factual claims. Correct material issues and
  re-run only affected focused tests before the full lane.
- [x] Run `node scripts/check-docs.mjs`, `node scripts/check-changesets.mjs`,
  `git diff --check`, and `pnpm ci:validate`. No changeset is expected for the
  private website alone; investigate rather than bypass a different result.
- [ ] Publish after this committed verification checkpoint: check active full CI
  submissions, then create a homepage PR with
  the visual preview, exact evidence identity, actual checks, and known limits.
  Preserve all local recordings. Do not merge on the authority of the earlier
  #640-specific merge request. Report preview and PR for the user's review.

## Planning review

Independent specification and complete-plan reviews passed on September 14, 2026.
The reviewer verified repository source equality between recorded and merged
commits; repaired target code retains separate recording provenance.

## Completion record

- Evidence checkpoint: `c8c0d4b4`; independent review passed after adding an
  independent whole-document integrity pin.
- Integration checkpoint: `c7a5271f`. Walkthrough, capabilities, composition, and metadata are implemented together
  as one integration checkpoint. No new model call or runtime dependency.
- Preview: `http://localhost:59620` (local production build).
- Browser review: 320/390/768/1280px, keyboard selection, result-first mobile
  layout, reduced motion, 200% content scaling plus 640px reflow,
  and JavaScript-disabled initial source/proof. Docs desktop/mobile menu and
  blog index retain existing styling. Screenshots stay in ignored
  `artifacts/visuals/`.
- Independent final review: all three findings fixed (curated patch link,
  named visible check, folded source emphasis); no remaining material findings.
- Web suite: 631 passed, one skipped; focused evidence/homepage/SEO: 50 passed.
  Web lint/typecheck and production build passed. Repository source tests:
  5,943 passed, 218 skipped. Full `pnpm ci:validate` passed with exit 0,
  including 3,850 release-controller tests, package checks, and all three
  framework/runtime/smoke harness lanes.
- Built SEO audit: 83 pages, 331 JSON-LD entities, 75 docs, three article
  social images, zero failures. Root 1200×630 social card visually verified.
  The audit's pre-existing date-count heuristic failed the current inventory;
  it now checks each sitemap date against the generated source record or
  authored blog date. Regression tests passed after confirming the failures.
- Changesets check confirms no publishable package change. Recordings and
  studies are preserved. PR creation follows this verification checkpoint;
  its URL and remote CI status are recorded in the final task response.
- Final production browser check: no page errors; 44px source, report, and
  header CTA targets. Logs are retained under ignored
  `artifacts/validation/developer-homepage/`; complete harness results under
  `artifacts/testing/harness-2026-09-14T174007-125Z-13509/`.
