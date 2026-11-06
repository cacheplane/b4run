# App Docs Interactive Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development when delegation is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render real recorded turns inline and full-page with deterministic replay, stable lesson links and optional pinned source.

**Architecture:** One client-side inspector consumes validated static captures and a server-owned lesson manifest. Pure playback state stays separate from rendering and artifact loading. A narrow MDX component contract connects teaching text to capture moments.

**Tech Stack:** React, TypeScript, CSS modules, existing MDX and syntax tooling, Vitest.

---

## Dependencies and files

Depends on capture plan Task 1's contract/reducer; the first public lesson additionally requires capture qualification and content/media review. Test fixtures remain explicitly synthetic. No HTTP inference client, iframe bridge or arbitrary JSON URL loader is needed.

Create under `apps/web/app/components/turn-inspector/`:
- `TurnInspector.tsx`: state orchestration, pane selection, controls.
- `ConversationPane.tsx`, `ActivityDetails.tsx`, `PlaybackControls.tsx`, `SourcePane.tsx`: focused views.
- `InspectorLoader.tsx`: lazy loading and validation; `InspectorFallback.tsx`: video/transcript fallback.
- `InspectMoment.tsx`, `inspector-context.tsx`: scoped MDX moment actions.
- `inspector.module.css`, `inspector.test.tsx`, `inspector-loader.test.tsx`, `source-pane.test.tsx`, `moment-links.test.tsx`, `playback.test.ts`.

Create under `apps/web/lib/turn-inspector/`:
- `playback.ts`: pure playback actions and clock scheduling seam.
- `lesson-types.ts`, `lessons.ts`: trusted author manifest and lookup, no capture payload in initial HTML.
- `source.ts`: server-side pinned source artifact reading; keep filesystem logic out of client bundles.

Create `apps/web/app/docs/app/inspect/[captureId]/page.tsx`, `apps/web/app/components/turn-inspector/inspector-routes.test.tsx`. Add MDX mappings in `apps/web/mdx-components.tsx` following its existing conventions. Optional source content is published by the capture pipeline, never fetched from a mutable working tree at browser runtime.

### Task 1: Build manifest and artifact loader

- [ ] Define a lesson entry with immutable capture ID/digest, asset paths, app/runtime/example revisions, source entries, lesson backlink and caption/transcript metadata. Capture IDs are lowercase slugs and resolved only from this manifest. Unknown IDs return 404; no user-controlled URLs reach fetch or filesystem reads.
- [ ] Write loader tests for loading, success, missing artifact, unsupported schema, over-limit response, abort/unmount, digest mismatch and malformed JSON. Test switching lessons cannot display a stale response from the previous load.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/inspector-loader.test.tsx`; expect missing loader behavior to fail.
- [ ] Implement lazy initialization on intersection or explicit user action; static prose/fallback renders server-side. Check declared response size and bound actual bytes while reading. Validate digest, schema and semantic references before render. A finite timeout and retry action lead to accessible fallback rather than a permanent loading state. No tokens are spent and no mutable endpoint is contacted.
- [ ] Rerun focused tests; expected PASS. Commit `feat(docs): load validated lesson recordings`.

### Task 2: Implement playback actions independently of UI

Files: `lib/turn-inspector/playback.ts`, `app/components/turn-inspector/playback.test.ts`, existing capture reducer.

- [ ] Write tests with an injected clock for play/pause, end-of-capture, jump backward, previous/next meaningful event, equal timestamps, turn change, and reduced-motion stepping. Selection and playback index must remain separate: inspecting an earlier item must not advance the clock.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/playback.test.ts`; expect failures.
- [ ] Implement actions `play`, `pause`, `seek(index)`, `selectActivity(id)`, `selectTurn(id)` around `stateAt`. Seek pauses, computes the exact prefix, removes selection if it no longer exists and preserves prior turns. Use one scheduler and cancel it on pause/unmount. Play stops at the final event. Timer delay affects display pacing only; recorded relative time remains visible.
- [ ] Implement meaningful stepping from actual changes (message start/end, tool start/end, request changes, turn changes), not every text delta. Do not promise timing finer than app-observed receipt time. Honor reduced motion by defaulting to static stepping and disabling animated scrolling.
- [ ] Rerun tests alongside `replay.test.ts`; expected PASS. Commit `feat(docs): add deterministic turn playback`.

### Task 3: Render conversation, details and responsive controls

Files: `TurnInspector.tsx`, pane/control components, CSS module and `inspector.test.tsx`.

- [ ] Write interaction tests for selecting a tool, readable input/result, unavailable field label, recorded pending/resolved approval, failed/cancelled/unknown turn, and repeated same-name tools selecting by ID. Test that malicious HTML/links render inertly, and no approval button submits a decision.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/inspector.test.tsx`; expect failures.
- [ ] Render chronological messages and activity with native-looking terminology but clear browser-inspector labeling. Present selected tool name, state, input and result using a bounded, expandable text/JSON viewer. Native payload fields must be normalized by the capture layer; components do not inspect arbitrary vendor fields.
- [ ] Add a turn selector, real buttons, labeled scrubber and visible event/time state. Desktop is conversation beside details; narrow containers use accessible tabs sharing the same mounted state. Long content scrolls inside bounded detail panes without clipping the page. Minimum tap target 44px; keyboard focus and selected state have non-color cues.
- [ ] Consume the documentation Hanken/JetBrains typography and B4 semantic tokens. Use light source/detail surfaces, hairline separators and neutral controls; relay marks selected fills, olive identifies links, focus uses the tested ring. No stacked decorative card treatment or colored accent text with inadequate contrast.
- [ ] Announce user-initiated changes, not every streamed delta. Autoscroll follows playback only until the reader manually scrolls away; provide a follow action. Make playback/text usable at 200% zoom and reduced motion.
- [ ] Rerun tests and inspect at 320/375/768/1024/1440 widths. Commit `feat(docs): render interactive recorded conversations`.

### Task 4: Connect lesson moments and full-page inspection

Files: `InspectMoment.tsx`, `inspector-context.tsx`, `moment-links.test.tsx`, full-page route and route tests, MDX mapping; modify `lib/llms-markdown.mjs` and its tests.

- [ ] Use this author-facing contract (adapt MDX registration syntax to the site's existing mapping):

```mdx
<TurnInspector lesson="navlog-first-turn" />

<InspectMoment lesson="navlog-first-turn" moment="weather-result">
  Inspect the weather result
</InspectMoment>
```

IDs are manifest-declared links to validated events, not tool-name substring matches. Moment labels are plain meaningful text in markdown exports.
- [ ] Tests: moment action lazy-loads once, pauses, switches to Replay, seeks/selects the specified item, scrolls with reduced-motion behavior and focuses the inspector heading. Invalid authored moment fails the publication/build validator. Stale or invalid incoming URL moment produces a visible note and a valid initial view without a crash.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/moment-links.test.tsx app/components/turn-inspector/inspector-routes.test.tsx`; expect failures.
- [ ] Add full-page route with static params from public manifest, exact capture metadata, lesson backlink and same inspector component. Inline action updates the URL fragment with capture/moment; playback ticks never push browser history. On a full page, copy-link preserves capture and moment; browser Back/Forward restores valid state.
- [ ] Keep capture utility routes out of authored navigation, prev/next and llms full-page concatenation. Include only approved indexable utilities in the SEO registry if useful; default `noindex` with canonical lesson link avoids thin duplicates. Ensure no-script output has a transcript/video and lesson link, not inert controls.
- [ ] Update markdown conversion to keep action text plus an absolute inspector deep link. Export must teach the lesson without embedded React markup. Rerun moment and llms tests; expected PASS. Commit `feat(docs): link teaching moments to recorded turns`.

### Task 5: Add pinned Source without runtime drift

Files: `SourcePane.tsx`, `lib/turn-inspector/source.ts`, `source-pane.test.tsx`; capture publisher source manifest.

- [ ] Tests: no Source tab when absent; manifest file picker; first highlighted range selected; mobile picker closes and returns focus; source hash/revision mismatch fails publication; line selection does not mutate replay; invalid path cannot read arbitrary files.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/source-pane.test.tsx`; expect failures.
- [ ] Adapt Hashbrown's source explorer behavior, not its SDK runtime. Bundle exact example/tool files from the recorded revision, with explicit allowlisted repository/path and hash. Links to GitHub use that revision. The manifest associates moment IDs with file/ranges and validates them at build/publication time. Never show a newer implementation as the recorded source.
- [ ] Lazy-load source only on demand. Highlight code using existing syntax tooling with a light theme mapped to central tokens; use a line marker and text label as well as color. A single compact file picker replaces the folder tree on narrow containers. Preserve selection across responsive changes.
- [ ] Rerun tests; expected PASS. Commit `feat(docs): inspect source at the recorded revision`.

### Task 6: Coordinate media and validate the whole experience

Files: new `apps/web/app/components/turn-inspector/media-coordinator.ts` and `media-coordinator.test.ts`; content/media plan's `DocsDemoVideo.tsx` uses the same coordinator.

- [ ] Implement and test a page-scoped media owner: playing a demo pauses replay, playing replay pauses video, unmount releases ownership. A nonplaying selection action does not unexpectedly start video. No autoplay.
- [ ] Add browser smoke assertions: no provider/coordinator network calls during playback; artifact failures show transcript fallback; keyboard and tap access; backward seek hides future results; source revision links remain fixed. Use the available browser test tooling without adding an unapproved dependency; document reproducible commands/steps in the gate record.
- [ ] Run targeted tests, all web tests, typecheck, lint and build, then required root gates for changed TS/MDX/CSS. Verify load cost does not embed captures or source in every docs page. Record measured capture size and loading behavior, not a fabricated performance budget.
- [ ] Keep synthetic fixtures out of the public manifest. Wire a public lesson only after capture/media qualification passes. Commit verified integration and report any unsupported adapter fields explicitly.
