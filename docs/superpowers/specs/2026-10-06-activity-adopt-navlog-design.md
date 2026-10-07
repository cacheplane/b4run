# Activity kit adoption: navlog on CopilotChat — design

Sub-project 2b-adopt of the activity-components arc
(`2026-10-03-b4-activity-components-design.md`), after 2b-restore
(`2026-10-05-activity-restore-from-storage-design.md`, #953 and #954). Decided with Brian on
2026-10-04 and 2026-10-06.

## 1. Decisions

- **The navlog chat dock becomes CopilotKit's own chat** (`<CopilotChat>`), skinned by the
  connector shipped in 2a (`B4Activity`, `useB4ChatSlots`). Navlog is the dogfood for the
  connector; its own transcript, tool cards, plan card, subagent panel and permission prompt go.
- **`connect` restores from B4's storage** through a B4-backed CopilotKit runner, not CopilotKit's
  in-memory history (lost on restart, eviction, a second instance, and in practice on Vercel).
- **The runner ships as `@b4run/ag-ui/copilotkit-runtime`**, beside the `./copilotkit` client
  connector. No new package.
- **Custom detail views only where the default breaks:** `renderChart` (its image) and
  `computeNavlog` (a summary pointing to the navlog sheet). Every other tool uses the kit's default
  `StepDetail`.
- **Legacy removal is complete:** the cards (`PlanActivityCard`, `ActivityChecklist`,
  `SubagentPanel`), the `classNames`/`components` slots, `cx`, the subagent-runs model
  (`reduceSubagentRuns`, `useSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `SubagentRun*`,
  `SubagentToolCall`, `SubagentEventSource`), `b4ActivityRenderers`, `b4PlanActivityRenderer` and
  `planActivityContentSchema`. `isSubagentMessage` stays (the connector uses it). `reduceTurns` is
  the one view model.
- **The chat example moves too:** its sidebar runs `B4Activity` + `useB4ChatSlots`.
- **The harness pins the DOM contract** (spec §5.6 of the components design), not legacy text;
  axe and a Playwright keyboard pass are added; dev dependencies are added as needed.
- Breaking changes are welcome; no compatibility shims.

## 2. Architecture

Four pieces, built bottom-up.

### 2.1 Replay endpoint: `GET /threads/:thread_id/events`

The thread as the AG-UI event stream its live runs would have carried, synthesised from the
checkpoint chain. `turns-from-state.ts` splits into two exported functions in
`@b4run/ag-ui/view`:

- `eventsFromState(input: ThreadStateForTurns): { events: BaseEvent[]; warnings: string[] }` — the
  synthesiser, ordered and clocked, every event carrying `timestamp` from the stamped and
  checkpoint times.
- `turnsFromState(input)` — `eventsFromState` folded through `reduceTurns` (unchanged contract).

Two additions make the event stream a complete chat replay:

- Each turn's `RUN_STARTED` carries `input: { threadId, runId, messages: [<the turn's user
  message as an AG-UI user message>], tools: [], context: [], state: {}, forwardedProps: {} }`.
  That is how CopilotKit's own replay restores user bubbles (its in-memory runner does the same).
- Assistant `TEXT_MESSAGE_*`, tool frames and results keep the checkpoint's message ids, so the
  client's message list matches what `/state` holds.

The parked head already ends with `RUN_FINISHED { outcome: { type: "interrupt", interrupts } }`;
CopilotKit's `useInterrupt` restores the approval from it (spike finding, 2026-10-04).

The handler sits next to `/turns` in `runtime-fetch-core.ts`, shares `gateThreadRead` with operation
`thread.events` (a new `ThreadOperation` member), reads through `loadThreadStateForTurns`, and
responds `200 { threadId, status, events, warnings, truncated }` with `cache-control: no-store`.
404 `thread_not_found`, a denied read in the same bytes, 409 `thread_route_unknown`, route
middleware — exactly as `/turns`.

### 2.2 Runner: `@b4run/ag-ui/copilotkit-runtime`

```ts
export interface B4AgentRunnerOptions {
  /** The B4 server's base URL (the one `B4HttpAgent` points at, without `/agui/...`). */
  readonly url: string
  /** Fetch used for the replay read; navlog passes its visitor- and token-forwarding fetch. */
  readonly fetch?: typeof fetch
}
export class B4AgentRunner extends InMemoryAgentRunner {
  constructor(options: B4AgentRunnerOptions)
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent>
}
```

- `run`, `isRunning`, `stop` are the in-memory runner's: a run forwards to the route's
  `B4HttpAgent` and keeps the in-memory live tail.
- `connect` checks `isRunning({ threadId })`. A live run in this process delegates to
  `super.connect` (rejoin). Otherwise it fetches `GET {url}/threads/{threadId}/events` with the
  configured fetch and emits the events in order, then completes. A 404 completes with no events
  (a new thread). Any other failure errors the observable with a message naming the status; the
  chat shows its error state and the thread is still usable for a new turn.
- The entry imports `@copilotkit/runtime/v2` and `rxjs`; `@copilotkit/runtime` becomes an optional
  peer of `@b4run/ag-ui` (pinned like `@copilotkit/react-core`). It is registered as a
  `node-only` server entry (it runs in the host's Node route, never in a browser bundle).

### 2.3 Navlog chat dock on `<CopilotChat>`

- `ChatDock` keeps its header (title, "+ New conversation", the "Threads" disclosure and
  `ThreadRail`) and the memory-candidates panel; its body becomes
  `<B4Activity renderStep={…}><Chat /></B4Activity>` where `Chat` is
  `<CopilotChat threadId={activeThreadId} {...useB4ChatSlots()} />`, keyed by the thread id so a
  switch remounts and reconnects.
- `renderStep` views: `renderChart` draws the SVG image part from the step's result;
  `computeNavlog` shows "66 nm · 2 legs · 5.5 gal" and a "See the navlog sheet" link that opens the
  sheet. Both live in the example as small components with tests.
- Suggestions stay on CopilotKit's `useConfigureSuggestions` (CopilotChat renders them in its
  welcome screen). Run errors use CopilotChat's error surface plus `copilotkit.subscribe({ onError })`
  for the dock's banner, as today.
- The map, navlog sheet and weather strip read from `useB4ActivityContext().turns`: the latest
  done `computeNavlog` step's result and the latest done `weather` subagent's result. They fill in
  after a reload.
- Deleted from the example and template: `Transcript`, `ToolCallCard`, `PlanCard`,
  `activity-renderers`, `PermissionPrompt`, `PermissionInterrupt`, `HydratedInterrupts`,
  `Composer` (CopilotChat's input replaces it), `EmptyState` if CopilotChat's welcome screen
  covers it, `lib/hydrate.ts`, `lib/transcript.ts`, `MediaParts` if only the transcript used it,
  and their tests. The proxy allowlist drops `GET threads/:id/state` and
  `GET threads/:id/pending_interrupts` (the runner reads the replay server-to-server); the
  memory-candidate routes stay.
- The Next route builds `new CopilotRuntime({ agents: { default: agent }, runner: new
  B4AgentRunner({ url: b4Url, fetch: guardedFetch }) })` with the same visitor-forwarding fetch the
  agent uses.
- Theme: `<html data-b4-theme="auto">`; navlog's `--wb-*` mapping extends to the kit's added
  tokens (`surface-alt`, `running`, `running-bg`, `failed`, `failed-bg`, `primary`,
  `on-primary`) and to CopilotChat's tokens so the chat, the kit and the Workbench agree in both
  schemes.
- The template twin (`packages/devkit/templates/app-navlog/web`) moves in lockstep; the parity
  test's `.test.ts(x).template` counts are updated.

### 2.4 Legacy removal and the chat example

- `@b4run/ag-ui/react` loses the legacy cards, slots, `cx` and the subagent-runs model;
  `@b4run/ag-ui/view` loses `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS` and the `SubagentRun*`
  types (keeps `isSubagentMessage`); `@b4run/ag-ui/copilotkit` loses `b4ActivityRenderers` and
  `b4PlanActivityRenderer`; the root loses `planActivityContentSchema` if exported there. The
  stylesheet's legacy `.b4-activity*` rules and the five legacy geometry tokens go.
- `examples/chat/web` uses `<CopilotSidebar>` with `B4Activity` + `useB4ChatSlots` (the sidebar
  accepts the same `messageView` slot props as `CopilotChat`).
- Docs: `/docs/api/ag-ui` tables (remove rows, add `./copilotkit-runtime` and `eventsFromState`),
  `ag-ui.mdx` "Consuming it from a web UI", the flight-planner web-UI recipe, the navlog and chat
  READMEs (example and template), `packages/ag-ui/README.md` (the rung sections go; the
  `scripts/readme-contracts.test.mjs` pins on them are replaced by pins on the new sections), the
  Agent Protocol endpoint table (`/events`), thread-access and security-architecture coverage rows,
  `llms.txt`, an upgrading entry, one changeset with a `**Breaking:**` lead.

## 3. Data flow

**Live turn.** CopilotChat's input → `copilotkit.runAgent` → Next route → `CopilotRuntime` →
`B4AgentRunner.run` → `B4HttpAgent` → B4 `/agui`. Events stream back through the in-memory runner
to the browser; `B4Activity`'s `useB4Turns` folds them; `useB4ChatSlots` renders one
`TurnActivity` per turn; approvals arrive through `useInterrupt` and resume through
`resolve`/`cancel`.

**Reload or thread switch.** CopilotChat (keyed by thread id) calls `connect` → `B4AgentRunner`:
live run in this process → rejoin; otherwise `GET /threads/:id/events` → events in order. The
browser sees the same event shapes as live, so CopilotChat rebuilds its messages and the kit its
turns, plan, subagents and any parked approval.

**Outside the chat.** Map, sheet and weather strip read turns; memory candidates keep their proxy
route.

## 4. Error handling

| Situation | Behaviour |
|---|---|
| Replay 404 (new thread) | `connect` completes with no events; empty chat |
| Replay 409 (thread never ran) | Same as 404 (nothing to restore) |
| Replay 5xx / network | `connect` errors with the status; the dock banner shows "Couldn't load this conversation" with a retry; a new message still works |
| Replay `warnings` | Logged once to the server console by the runner; not shown to the user |
| Replay `truncated` | The runner emits the events it has; the chat shows the newest turns |
| Gate denial | 404 bytes, handled as a new thread (the user cannot read it) |
| Live run in another instance | `connect` replays the checkpoint so far (the in-flight turn's last checkpoint); the user sees the rest after it settles or on the next reload |

## 5. Testing

- **View:** `eventsFromState` unit tests (user message in `RUN_STARTED.input`, message ids
  preserved, timestamps present, the existing `turnsFromState` tests pass unchanged since it
  becomes `reduce(eventsFromState)`).
- **Runtime:** `/events` endpoint tests mirroring `/turns` (gate, 404, 409, parked, drained,
  resumed, cap) and an equivalence test: a live AG-UI run's events vs `/events`, normalised, both
  reduce to equal turns and both yield the same CopilotKit message list
  (`@ag-ui/client`'s event→message applier).
- **Runner:** unit tests with a fake fetch and a fake in-memory live state: live → `super.connect`;
  not live → fetch and emit; 404 → empty; 500 → error; the configured fetch is used.
- **Navlog web:** component tests for the two `renderStep` views and the selectors over turns;
  the existing route, proxy and guard tests updated for the removed allowlist rows.
- **Harness:** W7 (restore) waits for the `connect` response instead of `/state` and asserts the
  restored DOM by contract: `section.b4-turn[data-state="done"]`, `li.b4-step[data-kind="tool"]`
  count, the answer text. W8 journeys pin `.b4-turn`, `.b4-step[data-kind="plan"]`,
  `.b4-step[data-kind="subagent"]`, `.b4-approval` with its "Allow once" button, and the answer
  text; the golden locator list is rewritten. `capture.mjs` (`restoreWorkbenchThread`,
  `runScenario`) follows.
- **Accessibility:** `axe-core` (or `@axe-core/playwright`) as a dev dependency where the
  harness runs; an axe pass on the restored dock with zero serious or critical violations; a
  keyboard pass: Tab to the turn summary, Enter toggles it (`aria-expanded`), Tab into a step and
  toggle it, Tab to "Allow once" and press Enter to resume.
- **Live demo verification:** after merge and deploy, drive the live navlog web (Vercel) with the
  built-in browser: plan a flight, reload, confirm the turn and steps restore; trigger the
  approval, reload while parked, confirm the approval card restores and resumes.

## 6. Rollout

Three PRs, each green on its own, merged in order:

1. **Replay + runner** — `eventsFromState`, `/events` + `thread.events`, `./copilotkit-runtime`
   with `B4AgentRunner`, registration and docs, changeset.
2. **Navlog and template on CopilotChat** — the dock, `renderStep` views, selectors over turns,
   proxy allowlist, theme, harness W7/W8 + golden list + capture script, axe and keyboard pass,
   template parity, READMEs, recipe.
3. **Legacy removal and the chat example** — removals across `./react`, `./view`, `./copilotkit`,
   root and the stylesheet; the chat example; docs, README contracts, upgrading entry, changeset.

Then the live-demo verification (§5) after the deploy workflow ships PR 2's server and web.

## 7. Out of scope

- A multi-instance runner with live rejoin across instances (cacheplane/b4run#928 remains for that).
- `b4.step` as an activity profile (#929).
- Restoring an awaiting step's running label (the checkpoint holds none until the call settles).
- Angular (sub-project 3) and threadplane (sub-project 4).
