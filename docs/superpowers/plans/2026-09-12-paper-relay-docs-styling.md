# Paper Relay Docs Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if delegated execution is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Paper Relay to the existing docs reading experience without changing shared site chrome, content, layout, or behavior.

**Architecture:** A docs-only styling boundary owns color and typography overrides. Stable component hooks support scoped styles; the search portal receives its own boundary. Shared MDX retains its default light appearance, while emitted dark syntax variables are used exclusively inside docs.

**Tech Stack:** Next.js App Router, React, Tailwind CSS 4, MDX/rehype-pretty-code, Vitest, existing browser inspection tools.

---

## Approved scope and working state

Read [the approved spec](../specs/2026-09-12-paper-relay-docs-styling-design.md)
and [brand guidelines](../../brand/guidelines.md). Work from the repository root
on `blove/paper-relay-docs-styling` in this existing dedicated worktree. PR #631
contains the prerequisite public kit; do not push docs implementation onto its
branch. If it remains unmerged, submit the docs PR against its branch to keep the
diff scoped, and state the dependency. Otherwise use main after reconciling the
merged history. Never merge either PR as part of this plan.

Preserve `ReadingLayout` grid, widths, breakpoints and sticky offsets. Preserve
`/docs` redirect. Exclude root layout, header/footer, `MobileMenu`,
`MobileDocsNav`, homepage, blog, nav inventory and technical content.

## File map

| Files | Responsibility |
| --- | --- |
| `apps/web/app/docs/layout.tsx` | Docs boundary and docs stylesheet import |
| `apps/web/app/docs/docs-brand.css` (new) | All Paper Relay rules, including scoped portal rules |
| `apps/web/app/components/docs/DocsSearch.tsx` | Portal boundary and stable search hooks |
| `apps/web/app/components/docs/DocsSidebar.tsx`, `DocsTOC.tsx` | Stable active-entry hooks and semantics |
| `apps/web/app/components/docs/DocsBreadcrumb.tsx`, `PageActions.tsx`, `RelatedCards.tsx`, `DocsPrevNext.tsx` | Stable styling hooks as needed; preserve behavior |
| `apps/web/mdx-components.tsx` | Stable table/prose hooks only where semantic selectors are insufficient |
| `apps/web/app/components/mdx/CodeBlock.tsx`, `CodeGroup.tsx`, `Tabs.tsx`, `Steps.tsx` | Stable hooks on existing containers/controls |
| `apps/web/app/components/mdx/Callout.tsx` | Type hook and docs-only explicit type label |
| `apps/web/lib/mdx-plugins.ts` | Dual light/dark syntax output, default still light |
| `apps/web/app/globals.css` | Only the narrowly scoped light syntax defaults needed by dual output on direct non-docs loads; no global theme changes |
| `apps/web/app/components/docs/docs-brand.test.tsx` (new) | Meaningful scope/semantic regression checks |
| `apps/web/app/components/docs/docs-syntax-theme.test.ts` (new if no equivalent exists) | Compile real code fence and verify both token palettes |

Do not touch every listed component automatically. Add hooks only where needed;
do not match literal Tailwind class strings. Leave `ui/CodeFrame.tsx` alone unless
an actual in-scope docs consumer requires a hook; its default appearance stays.

## Task 1: Baseline and test preparation

- [x] Confirm `git status --short --branch`, PR #631 state/head, and current
  `AGENTS.md`. Preserve other work. Run `pnpm install --frozen-lockfile` if needed.
- [x] Start `pnpm --filter @b4run/web dev --port 59621` from the root. Save baseline
  screenshots outside tracked source at desktop 1440 px, tablet 768 px, and mobile
  390 px. Use the same viewport and content positions for final comparisons.
- [ ] Baseline `/docs/routes` (prose/code), `/docs/getting-started` and
  `/docs/agents` (code groups), `/docs/permissions` (wide tables),
  `/docs/access-control` (warning), and `/docs/api/sdk` (API content). Use
  `rg -n '<Callout|<Steps|<Tabs' apps/web/content/docs` to select and record actual
  additional routes for info/tip/danger/steps/tabs. If a type is not used in
  content, verify its rendered component in tests instead of adding a public page.
- [x] Capture `/`, one existing `/blog/<slug>` from `apps/web/content/blog`,
  shared header/footer, and mobile menu for non-docs leakage comparisons.
- [x] Run `pnpm --filter @b4run/web test` and record the baseline. Inspect current
  search/page-action/anchor tests before adding coverage; avoid duplicate suites.
- [x] Add focused failing tests for the new boundary and semantic changes: docs
  wrapper and rendered search portal have explicit scopes; callout types remain
  identifiable without titles inside docs; custom titles/content remain intact;
  non-docs callouts have no newly visible labels. Use DOM/render tests, not CSS
  string snapshots. Portal coverage must open the search dialog after mount.
  Use a file-level jsdom environment for DOM/portal tests; the web suite defaults
  to Node. New tests live under `app/`, which its Vitest config includes.

## Task 2: Scope and shared rendering contracts

- [x] In `docs/layout.tsx`, import `./docs-brand.css` and wrap the existing
  `ReadingLayout` in `<div data-docs-brand>`. Do not add overflow/transform or
  positioning that changes sticky behavior.
- [x] Add `data-docs-brand` to the existing root of the `DocsSearch` portal. Keep
  its fixed positioning, overlay, keyboard handling, query/results, and navigation
  unchanged. `PageActions` is currently an inline absolute dropdown, not a portal;
  it inherits the docs boundary.
- [x] Add stable hooks such as `data-docs-nav-item`, `data-active`,
  `data-code-frame`, `data-code-header`, and `data-callout-type` to existing DOM
  elements where needed. Preserve existing default utility classes.
- [x] For callout type labels, use the smallest docs-only rendering mechanism.
  One viable approach is a small client context provider at the docs boundary
  and a context-aware label subcomponent inside the existing server-compatible
  Callout. It returns null outside docs, and renders Info/Tip/Warning/Danger
  inside docs alongside any custom title. Do not convert all MDX or the root
  layout into client components. Add `DocsBrandProvider.tsx` under
  `app/components/docs/` if this mechanism is chosen and cover its default case.
- [x] Run `pnpm --filter @b4run/web test app/components/docs/docs-brand.test.tsx`.
  Expected: new boundary/label tests pass; existing tests remain for later suite.
- [x] Commit the small scoping/semantic change with a focused message.

## Task 3: Dark syntax without blog regressions

- [x] Add a real MDX compilation test using the existing plugin list and a code
  fence with keywords, strings, comments and plain identifiers. Assert heading
  IDs/code text remain unchanged and tokens provide light and dark color values.
  Run `pnpm --filter @b4run/web test app/components/docs/docs-syntax-theme.test.ts`; expect failure
  before changing the single-theme pipeline.
- [x] Configure `rehype-pretty-code` with
  `theme: { light: "github-light", dark: "github-dark" }`, retaining
  `keepBackground: false` and existing language defaults. Inspect the actual
  emitted HTML for installed versions before writing selectors. Preserve the
  light token appearance outside docs. Installed dual-theme output disables
  default inline colors, so place narrowly targeted light token defaults in
  always-loaded `app/globals.css`, matching actual emitted syntax token hooks.
  Map light foreground/style/weight/decoration variables to their CSS properties
  with safe fallbacks. These rules only restore the previous light presentation
  for dual-theme code; do not change root tokens or prose. Scoped docs rules must
  win by specificity regardless of stylesheet load order. Do not globally
  activate dark mode or depend on docs CSS to style a direct blog load.
- [x] Under `[data-docs-brand]` only, select emitted dark variables for token
  color (normally `--shiki-dark`), background, font style, weight and decoration
  where supplied. Set plain code foreground to paper and frame background to
  `#17181B`. Verify actual syntax contrast and adjust a docs-only token palette
  if needed; do not replace all token colors with a single foreground.
- [x] Run the compilation test and existing MDX/anchor tests. In the browser,
  compare a fresh direct blog load against baseline, then navigate blog → docs
  → blog and inspect computed token colors in each. Also test a direct docs load. Expected: light blog code, dark docs code, unchanged code text.
- [x] Commit the syntax-output change with its regression test.

## Task 4: Apply the approved component treatments

- [x] Define scoped tokens in `docs-brand.css`: paper `#F5F4F0`, ink `#111111`,
  dark `#17181B`, Relay `#B4CE37`, tint `#E7EDD1`; use neutral muted text and
  dividers meeting the spec's contrast rules. Root/body token defaults remain.
- [x] Apply Inter to docs headings/prose and JetBrains Mono to code/labels using
  existing font variables. Override shared display typography only within docs.
  Preserve heading scale and reading width; remove irrelevant font-variation
  settings within docs if necessary for predictable Inter rendering.
- [x] Style active navigation with tint and an ink marker, preserving
  current-page semantics; decorate article h2 sections with thin rules and small
  Relay markers using empty pseudo-elements. No text glyphs in heading content.
- [x] Style square dark code frames/header bars, copy states, group tabs and
  selected indicators. Keep inline code neutral and light; prevent rules for
  inline code from leaking into block code. Preserve mobile inline wrapping.
- [x] Style info/tip callouts with tint and ink labels. Warn/danger retain distinct
  semantic colors and explicit labels. Style tables, steps, tabs, related cards,
  previous/next links, breadcrumbs, page actions and search results consistently.
- [x] Use underlined prose links and square buttons. Provide ink focus outlines
  on paper and contrasting light outlines on dark surfaces, including selected,
  hover and copy-feedback states. Decorative pale rules are not control outlines.
- [x] Preserve scoped overflow for code/tables and existing mobile UI. Do not
  use blanket `overflow:hidden` or global border-radius resets as shortcuts.
- [x] Run `pnpm --filter @b4run/web lint` and `pnpm --filter @b4run/web test`.
  Expected: pass; fix only changes attributable to this work. Commit treatments.

## Task 5: Browser verification, review and submission

- [x] Repeat baseline views at all three widths. Check text/syntax contrast,
  loaded and fallback fonts, h2 decoration, no page overflow, code/table scroll,
  active outline, sticky offsets, and all callout variants. Record screenshots
  and exact routes outside tracked application source.
- [x] Exercise keyboard search including no results, result navigation and
  Escape; copy controls and feedback; page-action menu; tabs; anchor navigation;
  previous/next; and the unchanged mobile menu. Test portal focus visibly.
- [x] Compare non-docs pages/chrome against baseline. Any visual leakage blocks
  completion. Re-run targeted checks after fixes; do not claim blocked browser
  scenarios passed or bypass browser URL policy restrictions.
- [x] Run `git diff --check`, `pnpm build`, `pnpm --filter @b4run/web typecheck`,
  `node scripts/check-docs.mjs`, and `node scripts/check-changesets.mjs`. Build
  before checks consuming package dist. No package changeset is expected.
- [x] Run `pnpm ci:validate` and record outcomes. This is not the narrow prose
  exception. Diagnose failures using @superpowers:systematic-debugging; retain
  original and rerun results separately. Do not claim an aggregate pass after
  merely rerunning one failed test.
- [x] Use @superpowers:requesting-code-review for a bounded review against the
  spec, emphasizing shared-style leakage, dark token rendering, mobile header
  exclusion, and interaction preservation. Resolve substantive findings.
- [x] Update spec/plan status and commit the final result. Check PR #631 state
  and active GitHub workflow runs; respect the two-active-full-CI submission
  constraint, including main. Push only after local checks/review permit it.
- [ ] Create the docs PR on the correct base as described above, using a body
  file. Explain docs-only scope, retained layout, screenshots, actual validation,
  and remaining limitations. Verify remote head and report CI without claiming
  uncompleted remote jobs passed. Do not merge or alter production settings.

## Handoff

Independent plan review approved after correcting the direct-load light syntax
boundary. Implementation completed inline in `fd396571`, with one cohesive
implementation commit after the scoping, syntax, and treatment checks rather
than separate intermediate commits. Independent code review approved with no
substantive findings.

Verification record:

- Baseline website suite: 606 passed, one skipped. Final website suite: 612 passed,
  one skipped. The new regression suites failed before implementation; all six new
  semantic/syntax tests passed afterward. Final web lint passes without warnings.
- Browser inspected Routes, Agents, Permissions, Access Control, State, SDK API
  reference, and Testing at representative 1440/768/390 px widths. Code and
  tables stay contained; checked pages have no horizontal page overflow.
- Search query/results and empty state, Escape dismissal, code copy and feedback,
  keyboard code-tab selection, page actions, anchors, and mobile menu were checked.
  Info and tip labels were checked on real pages; danger is covered in component
  tests because no current docs page uses that callout type.
- Direct blog load and docs-to-blog navigation preserve sampled syntax colors,
  heading font, header markup and footer markup. Homepage stays outside scope.
- Blocked actual font requests in a separate browser session: Inter and JetBrains
  Mono fell back successfully, with no horizontal overflow at 390 or 1440 px.
- GitHub Dark comments initially measured 3.69:1; docs-only adjustment raises
  contrast. Final Routes token audit has zero colors below 4.5:1 (minimum 6.68:1).
- Screenshots and comparison data are local in `/tmp/b4-docs-visual/`.
- Final website build and docs completeness passed. Full source suite passed:
  5,881 tests passed, 218 skipped. The complete `pnpm ci:validate` run exited 0:
  release-controller (3,727 tests), package and TypeScript tooling checks,
  chart-version checks, docs completeness, and all three harness lanes passed.
  Harness artifacts: `artifacts/testing/harness-2026-09-13T030024-620Z-45114/`.
  The final web build was also rerun successfully after the comment-contrast fix.
- Baseline screenshots cover Routes at all three widths and the homepage/blog
  at desktop. The additional representative docs pages were inspected after
  implementation; no before screenshots were captured for every listed route.

The implementation adds a small docs context provider and label leaf. New tests
live under `app/` for existing Vitest discovery; portal tests use jsdom. Shared
light syntax defaults live in root CSS but target only emitted syntax tokens;
all Paper Relay colors and dark syntax rules remain under the docs boundary.
