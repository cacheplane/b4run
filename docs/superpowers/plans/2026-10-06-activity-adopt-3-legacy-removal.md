# Activity adopt, PR 3: legacy removal and the chat example (implementation plan)

**Goal:** Remove the legacy activity surfaces from `@b4run/ag-ui` and move the chat example onto
`B4Activity` + `useB4ChatSlots`. `reduceTurns` becomes the one view model.

**Spec:** `docs/superpowers/specs/2026-10-06-activity-adopt-navlog-design.md` §1, §2.4, §6 item 3.
Stacked on PR 2 (`blove/activity-adopt-2`). Breaking; no shims.

**Ground rules:** Node 24, scoped Biome (`--config-path` from the package dir), commit trailer,
commit docs before `pnpm --dir apps/web seo:lastmod` and commit the manifest separately.

## Inventory (by grep, excluding `node_modules`, `dist`, `.next`, `CHANGELOG*.md`, `docs/superpowers`)

### `@b4run/ag-ui` source

| Path | Action |
|---|---|
| `src/react/PlanActivityCard.tsx`, `ActivityChecklist.tsx`, `SubagentPanel.tsx` | delete |
| `src/react/parts.ts` (`cx`, `B4ActivityClassNames`, `B4ActivityComponents`, `B4TodoRowProps`, `B4ToolRowProps`) | delete |
| `src/react/schemas.ts` (`planActivityContentSchema`; only `renderers.tsx` and the react barrel use it) | delete |
| `src/react/useSubagentRuns.ts` (`useSubagentRuns`, `SubagentEventSource`, re-exports) | delete |
| `src/react/index.ts` | drop the legacy exports and the subagent-model re-exports (`isSubagentMessage` too: it stays in `./view`); rewrite the header comment |
| `src/copilotkit/renderers.tsx` (`b4ActivityRenderers`, `b4PlanActivityRenderer`) | delete; drop from `src/copilotkit/index.ts` |
| `src/copilotkit/useB4Turns.ts` | imports `SubagentEventSource` from the deleted hook: type the parameter `Pick<AbstractAgent, "subscribe">` directly |
| `src/view/subagent-runs.ts` (`reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `SubagentRun`, `SubagentRunsState`, `SubagentToolCall`) | delete; its two survivors move: `readPlan` (used by `turns.ts`, `turns-from-state.ts`) to `src/view/plan.ts`, `isSubagentMessage` (used by `copilotkit/messages.ts`) to `src/view/messages.ts` |
| `src/view/index.ts` | export `isSubagentMessage` from `./messages.js`; drop the rest |
| `src/react/styles.css` | delete the "Legacy cards" block (every `.b4-activity*` rule) and the five geometry tokens (`gap`, `font-size`, `margin`, `padding`, `header-weight`); `--b4-activity-badge-bg` is only a fallback inside the deleted badge rule. Every remaining class is emitted by `src/react/activity/*` (the styles test checks it). `--b4-activity-complete` stays: it is a documented palette token navlog themes |
| root `src/index.ts` | no change: `planActivityContentSchema` was never exported there; `B4_PLAN_ACTIVITY_TYPE`/`B4PlanActivityContent` stay (outbound emits `b4.plan`, `reduceTurns` reads it) |

### `@b4run/ag-ui` tests

| Path | Action |
|---|---|
| `test/react/SubagentPanel.test.tsx`, `useSubagentRuns.test.tsx`, `customization.test.tsx`, `schemas.test.ts`; `test/copilotkit/renderers.test.tsx` | delete (the `isSubagentMessage` case moves to `test/view/messages.test.ts`) |
| `test/react/public-api.test.ts`, `test/view/public-api.test.ts`, `test/copilotkit/public-api.test.ts` | new export lists; the view no-React check lists the new files |
| `test/react/styles.test.ts` | add: no `.b4-activity` class rule, no geometry token, every `.b4-` class in the sheet is emitted by the kit |

### Chat example (`examples/chat/web`)

- `app/page.tsx`: `CopilotKit` without `renderActivityMessages`; `B4Activity` around a `CopilotSidebar`
  that takes `messageView={useB4ChatSlots().messageView}`; `PermissionInterrupt` goes (CopilotKit has
  one interrupt slot and `B4Activity` fills it with `ApprovalCard`); `DemoSuggestions` stays.
- `app/components/PermissionInterrupt.tsx`: delete.
- `app/layout.tsx`: stylesheet comment.
- `app/api/copilotkit/[...path]/route.ts`: `runner: createB4AgentRunner(InMemoryAgentRunner, { url })`
  (no auth in this example, so the default `fetch`).
- `e2e/copilotkit-v2.spec.ts`: keep the transport test; add a DOM-contract test against a fixture B4
  server (no model): a fixture `/agui` stream with a tool call renders `section.b4-turn`,
  `li.b4-step[data-kind="tool"]` and the answer text, and an interrupt renders `.b4-approval` with
  "Allow once". The Playwright `webServer` gains the fixture server.
- `README.md` (web and `examples/chat/README.md`): the activity kit, the runner, the approval card.
- No harness lane drives the chat example (`test/` greps only hit `security-dependencies`, which
  imports the route module: `copilotkit-v2-runtime.test.ts` must stay green with the runner).

### Docs and pins

| Path | Action |
|---|---|
| `apps/web/content/docs/api/ag-ui.mdx` | remove the rows for every removed export in `./view`, `./react`, `./copilotkit`; remove the "Deprecated:" paragraph and the legacy-token paragraph |
| `apps/web/content/docs/ag-ui.mdx` | remove "Deprecated: the legacy subagent tree…"; fix the peer-deps paragraph (`reduceSubagentRuns`, `b4ActivityRenderers`); rewrite the `writeTodos` callout |
| `apps/web/content/docs/recipes/flight-planner-web-ui.mdx` | replace the legacy-renderer half of "Render plan and subagent activities" with the kit (`TurnActivity`/`useB4Turns` for a host without `B4Activity`) |
| `apps/web/content/docs/upgrading.mdx` | new entry: what was removed, what replaces it; amend the earlier entries that promise the legacy cards "still ship" |
| `packages/ag-ui/README.md` | delete "React renderers" and "Customizing the activity cards" rungs 2-4; keep a "Styling" section (tokens, dark mode); drop the `b4ActivityRenderers` moved line |
| `scripts/readme-contracts.test.mjs` | `@b4run/ag-ui` caveat pins move from "## React renderers"/`b4ActivityRenderers`/rungs to the current sections (`## Activity components`, `## CopilotKit connector`, `useB4ChatSlots`, the styling section's `@layer b4-activity` caveat) |
| `packages/devkit/templates/app-navlog/server/README.md` | the plan/subagent paragraph points at `B4Activity` |
| `apps/web/app/llms*.txt` | generated from content; check after the edits |
| `.changeset/activity-legacy-removal.md` | `"@b4run/ag-ui": patch`, `**Breaking:**` lead |

Existing pending changesets (`ag-ui-view-entry`, `ag-ui-react-kit`, `agui-subagents`) are the
release's history and stay; the new changeset states the end state.

## Verification

`pnpm build && pnpm lint && pnpm typecheck && pnpm test`; `node scripts/check-docs.mjs`;
`pnpm check:release-inventory`; `pnpm pack:check`; `node --test scripts/readme-contracts.test.mjs`;
chat web `typecheck`, `build`, `lint`, `test:e2e`; `test/security-dependencies/copilotkit-v2-runtime.test.ts`;
then `pnpm --dir apps/web seo:lastmod`.
