# Activity kit for Angular, PR 2: the components (implementation plan)

**Goal:** A new workspace package, `@b4run/ag-ui-angular` (private for now), that renders the
activity DOM contract from the same view core as the React kit, with a parity test that fails
whichever kit drifts.

**Spec:** `docs/superpowers/specs/2026-10-07-activity-angular-kit-design.md` §1, §2, §3 and
rollout item 2; the arc spec `2026-10-03-b4-activity-components-design.md` §3, §5 and §5.6.
Not in this PR: the CopilotKit Angular connector (`./copilotkit`, rollout item 3), the release
train (item 4).

**Ground rules:** Node 24, scoped Biome (`--config-path ../config-biome/biome.json` from the
package dir), commit trailer, commit docs before `pnpm --dir apps/web seo:lastmod` and commit
the manifest separately. Changeset for `@b4run/ag-ui` only (the new package is private).

## 1. One implementation of the pure helpers

Every framework-free rule the React kit keeps in `src/react/activity/*` moves to
`@b4run/ag-ui/view`, React imports it from there, and the Angular kit imports the same module.

| From (`src/react/activity/`) | To (`src/view/`) | What |
|---|---|---|
| `format.ts` (whole file) | `activity-format.ts` | `formatDuration`, `countSteps`, `countSources`, `summaryLine`, `SummaryLine`, `planProgress`, `reasoningLabel` |
| `TurnActivity.tsx` `nestedSummary` | `activity-format.ts` `nestedSummaryLine` | a subagent turn's summary |
| `Step.tsx` `meta`, `customRenderer` own-key lookup | `activity-format.ts` `stepMeta`, `ownEntry` | the muted tail; own-key lookup of per-tool renderers |
| `StepGroup.tsx` sources tail | `activity-format.ts` `groupMeta` | "· N sources" |
| `PlanStep.tsx` `statusLabel` | `activity-format.ts` `todoStatusLabel` | the hidden "(done)" text |
| `SubagentStep.tsx` state map, meta, folded text | `activity-format.ts` `subagentRowState`, `subagentMeta`, `subagentSettledText` | |
| `StepDetail.tsx` `prettyValue`, `capDetail`, `MAX_DETAIL_CHARS` | `activity-format.ts` | detail text |
| `SourceChips.tsx` `isSafeHref` | `activity-format.ts` | link allow-list |
| `ApprovalCard.tsx` `approvalPayload`, `scopeLine`, `ApprovalDecision` | `activity-approval.ts` | approval card text |
| `Disclosure.tsx` `useDisclosure` body | `activity-disclosure.ts` | `DisclosureMemory`, `initialDisclosure`, `observeDisclosure`, `toggleDisclosure`, `isDisclosureOpen`: the open/closed rule as a pure reducer |
| `useLive.ts` timers | `activity-timing.ts` | `NO_FLASH_MS`, `noFlashRemaining`, `sampleElapsed` (the once-a-second sampler) |
| `icons.tsx` glyph geometry | `activity-glyphs.ts` | `STEP_GLYPHS`, `stepGlyph`, `CHEVRON_GLYPH`, `CHECK_PATH`: shapes as data (`{ tag, attrs }`) both kits draw |

`./react` keeps exporting `approvalPayload`, `formatDuration`, `scopeLine`, `summaryLine` (now
re-exports) so its public API is unchanged. Docs: the `/view` table in
`apps/web/content/docs/api/ag-ui.mdx` gains a row per new export; `test/view/public-api.test.ts`
lists them and the no-React check covers the new files. Changeset: `@b4run/ag-ui` patch.

## 2. Shared fixtures and the contract snapshot

| Path | What |
|---|---|
| `packages/ag-ui/test/fixtures/activity-fixtures.ts` | `TURN_FIXTURES` (every turn state, every step kind and state, groups, sources with safe and unsafe hrefs and overflow, details as JSON, text, empty and truncated, nested subagents running/paused/done/failed) and `APPROVAL_FIXTURES` (offers always or not, every scope line, subagent payload, a pending and a failed decision). Each has a fixed `now`. |
| `packages/ag-ui/test/fixtures/contract-serializer.ts` | `serializeContract(root)`: elements and text, attributes sorted, classes sorted; drops comments, whitespace-only text, `style`, Angular's `ng-*`/`_ng*` markers and selector-marker attributes (`b4-*`); unwraps `b4-*` host elements. `expandAll(root, click)`: clicks every collapsed `button[aria-expanded="false"]` until none is left. |
| `packages/ag-ui/test/fixtures/activity-contract.snap.json` | One committed snapshot: per fixture, the initial render and the fully expanded render. |
| `packages/ag-ui/test/react/parity.test.tsx` | Renders every fixture with the React kit and compares to the snapshot (`B4_UPDATE_CONTRACT=1` rewrites it). |
| `packages/ag-ui-angular/test/parity.spec.ts` | The same fixtures through the Angular kit, compared to the same file (never written from Angular). |

The React component tests that build these views inline import them from the fixtures file.

## 3. The package

| Path | What |
|---|---|
| `package.json` | `private: true`, version of the fixed group, MIT, `engines.node >=24`, `files: ["dist"]`, hand-written `exports` into ng-packagr's output (`dist/fesm2022/*.mjs`, `dist/types/*.d.ts`) and `./styles.css`; Angular 22 peers; exact devDeps (Angular 22.2.1, ng-packagr 22.2.4, compiler-cli, `typescript` 6.0.2 (the version `@b4run/core` already pins: a second 6.0.x makes pnpm move core's `@typescript/old` range onto it), analog 2.8.0, `@angular/build` for analog, jsdom, axe-core). |
| `ng-package.json` | `dest: dist`, entry `src/index.ts`, `allowedNonPeerDependencies: ["@b4run/ag-ui", "tslib"]`. |
| `tsconfig.json` / `tsconfig.lib.json` / `tsconfig.spec.json` | strict, `exactOptionalPropertyTypes`, Angular strict templates; outputs under `dist/` per `check:build-cache`. |
| `scripts/copy-styles.mjs` | Copies `@b4run/ag-ui/react/styles.css` to `dist/styles.css` after ng-packagr. A copy, not `@import`: it works with every bundler and a plain `<link>`, and bare-specifier `@import` resolution differs between CSS toolchains. |
| `src/index.ts` | Public API. |
| `src/lib/*.ts` | Components (below), `disclosure.ts` (signal wrapper around the shared reducer), `timing.ts` (`elapsedSignal`, `liveSignal`), `svg-attrs.directive.ts`. |
| `vitest.config.ts`, `test/setup.ts` | analog's Angular plugin, jsdom, zoneless TestBed. |
| `README.md` | Usage, the selector table, the styles entry, status (private). |

### Components

Standalone, `ChangeDetectionStrategy.OnPush`, `input()`/`output()`, no NgModules.

| React | Angular selector | Host |
|---|---|---|
| `TurnActivity` | `b4-turn-activity` | element, `display: contents` |
| `Step` | `li[b4-step]` | the contract `li.b4-step` itself |
| `StepGroup` | `li[b4-step-group]` | the contract `li` |
| `PlanStep` | `li[b4-plan-step]` | the contract `li` |
| `ReasoningStep` | `li[b4-reasoning-step]` | the contract `li` |
| `SubagentStep` | `li[b4-subagent-step]` | the contract `li` |
| `StepDetail` | `b4-step-detail` | element, `display: contents` |
| `ApprovalCard` | `b4-approval-card` | element, `display: contents` |
| `SourceChips` | `b4-source-chips` | element, `display: contents` |
| `Disclosure` | `b4-disclosure` | element, `display: contents` |
| `StepIcon` | `b4-step-icon` | element, `display: contents` |
| `Checklist` | `b4-checklist` | element, `display: contents` |

**Deviation from the spec's element selectors for the five row components.** A custom element
between `ol.b4-turn__steps` and its `li` fails axe's `list` and `listitem` rules (serious; checked
with `display: contents` and with `role="none"`), and it breaks the sheet's child combinators
(`.b4-step[data-state] > .b4-step__line`). Rows therefore attach to the contract `li` with an
attribute selector, the Angular idiom (`li[b4-step]`). For the same reason the rows and the turn
render their disclosure button inline rather than through `<b4-disclosure>`, which stays a
building block for custom content. The nested turn inside `.b4-step__children` is a
`<b4-turn-activity>` host, so the two sheet rules `.b4-step__children > .b4-turn` and
`.b4-step__children > .b4-turn > .b4-turn__steps` become descendant selectors; in the React DOM
every such `.b4-turn` is a direct child, so React matches exactly what it matched before.

## 4. Tests (`packages/ag-ui-angular/test`)

One spec per component, ported from `packages/ag-ui/test/react/*`; `format.test.ts` stays in
`@b4run/ag-ui` (it now tests the view module). Plus:

- `parity.spec.ts` (above) and `a11y.spec.ts`: axe on every fixture, initial and expanded, zero
  serious or critical violations.
- `styles.spec.ts`: every class the Angular templates emit has a rule in the shared sheet, and
  every `.b4-` class in the sheet is emitted by the Angular templates.
- `public-api.spec.ts`: the export list; nothing imports React or CopilotKit.

## 5. Wiring

- AGENTS.md workspace map row (Capabilities & integrations).
- `turbo.json`: none needed for reads of `@b4run/ag-ui` (a declared dependency); `pnpm
  check:build-cache` confirms.
- Docs page `/docs/api/ag-ui-angular`: **deferred**. API reference leaves must belong to
  `PACKAGE_CATALOG`, which `check-docs` pins to the 21 public packages, so registering the page
  needs the package on the release train (rollout item 4). The README carries the usage until then.
- Release inventory and pack check skip private packages; verify.

## 6. Tasks

1. Plan (this file).
2. View moves (§1), React rewired, view public API, docs rows, changeset; sheet selector change.
3. Fixtures, serializer, snapshot, React parity test; React tests import the fixtures.
4. Package scaffold: manifests, tsconfigs, ng-packagr build + styles copy, vitest setup; build,
   typecheck, lint wired through turbo.
5. Components.
6. Component specs, parity, axe, styles, public API.
7. README, AGENTS.md.
8. Docs commit, then `seo:lastmod` commit.
9. Full gate: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm
   check:release-inventory && node scripts/check-docs.mjs && pnpm pack:check && pnpm
   check:build-cache`.
