# B4 inspector workbench implementation plan

> Execute inline with superpowers:executing-plans, following the owner's existing execution preference. Use checkbox steps to track progress.

**Goal:** Match Hashbrown's compact workbench hierarchy using B4 colors and the real beta recording.

**Architecture:** Keep the capture parser, reducer, loader and published artifacts. Extend the pure playback helpers, replace the detail presentation with bounded modes, and compose conversation/detail above a shared bottom player. Add no runtime service or dependency.

**Tech stack:** Existing React, CSS modules, TypeScript, Vitest/jsdom and browser tooling.

## Task 1: Playback model and controls

Files: `apps/web/lib/turn-inspector/playback.ts`, `apps/web/app/components/turn-inspector/PlaybackControls.tsx`, new `InspectorIcon.tsx`, existing `playback.test.ts`.

- [ ] Add failing tests for turn boundaries and speed-scaled waits with unchanged timestamps.
- [ ] Run `pnpm --filter @b4run/web exec vitest run --config vitest.config.ts app/components/turn-inspector/playback.test.ts --maxWorkers=1`; verify failure.
- [ ] Add pure turn-start helpers and bounded speed to delay calculation. Keep current selection/seek invariants.
- [ ] Build functional inline SVG transport, native event slider, labeled turn segments, moment buttons and speed control. Keep accessible transport names and native keyboard handling.
- [ ] Rerun the playback tests; require pass.

## Task 2: Focused detail viewer

Files: `ActivityDetails.tsx`, new `ValueTree.tsx` and `activity-details.test.tsx` in `apps/web/app/components/turn-inspector/`.

- [ ] Write failing interaction tests for Arguments/Result/Event, unavailable values, structured expansion, escaped text and selection changes.
- [ ] Run that test file with the same focused Vitest command and verify failure.
- [ ] Render one detail body and compact mode controls. Preserve original observed values; label any parsed JSON string as derived. Use native disclosures, a depth limit and incrementally revealed collection entries.
- [ ] Rerun tests and verify pass.

## Task 3: Workbench layout and message typography

Files: `TurnInspector.tsx`, `ConversationPane.tsx`, `inspector.module.css`, `InspectorLoader.tsx`, `SourcePane.tsx`, `inspector.test.tsx`, `moment-links.test.tsx`.

- [ ] Adapt interaction tests to accessible transport names and add a player-position/moment-selection regression.
- [ ] Compose header, two panels, detail modes and bottom player. Keep Source pause behavior, lazy asset loading and direct-link remount fix.
- [ ] Present user/assistant messages in proportional text, selectable tool rows and turn groups. Keep approvals inert and unknown values honest.
- [ ] Apply local tokens, panel radius, 4px spacing rhythm, 44px targets, selected-edge markers and narrow pane switching. Apply compact source styling and keep source loading independent.
- [ ] Run all inspector and Markdown tests from the root runner with `--maxWorkers=1`; require pass.

## Task 4: Browser review and verification

- [ ] Inspect the real beta recording, source, tree/JSON modes, backward seek, direct moments and speed controls in the browser.
- [ ] Check 320/375/768/1024/1440px for overflow and target sizes; check reduced-motion and keyboard behavior.
- [ ] Run scoped Biome, website lint/typecheck/build and existing export/manifest tests. Fix actual regressions without broadening scope to prior unrelated sandbox timeouts.
- [ ] Save a new screenshot and gate evidence, commit the implementation, and regenerate SEO lastmod only if its content check requires it. No push or deployment.
