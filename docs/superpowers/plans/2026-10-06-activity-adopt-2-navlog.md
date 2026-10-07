# Activity adopt, PR 2: navlog and template on CopilotChat (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or superpowers:executing-plans). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The navlog chat dock becomes stock `<CopilotChat>` inside `<B4Activity>`. The thread is restored server-side by `B4AgentRunner`. The map, sheet and weather strip read turns. The template twin moves in lockstep. The harness pins the kit's DOM contract and adds axe plus a keyboard pass.

**Spec:** `docs/superpowers/specs/2026-10-06-activity-adopt-navlog-design.md` §2.3, §5, §6 item 2. It depends on PR 1 (`B4AgentRunner`, `GET /threads/:id/events`).

**Ground rules:** PR 1's rules apply: Node 24, scoped Biome, a commit trailer, and stage only your own files. **Every web change is made twice**, in `examples/navlog/web/app/**` and in `packages/devkit/templates/app-navlog/web/app/**`. Test files in the template are named `*.test.ts(x).template`.

---

## 0. Findings that shape the plan (read first)

These are things I checked in the installed code. Several of them contradict the spec as written.

1. **`useB4ActivityContext` is not exported.**
   - `packages/ag-ui/src/copilotkit/index.ts` exports only `B4Activity`, `mergeTurnMessages`, the renderers, `useB4ChatSlots` and `useB4Turns`.
   - The hook lives in `B4Activity.tsx:24-30`.
   - PR 2 has to export it, along with the `B4ActivityContextValue` type. That means updating the public-api test, adding a docs row and adding a changeset.

2. **The welcome screen never shows with an explicit thread.**
   - `CopilotChatView` renders the welcome screen only when `!hasExplicitThreadId` (`copilotkit-LD7Gp2aV.mjs:8303`). `CopilotChat` sets that flag whenever `threadId` is passed (`:8830`).
   - So the welcome screen can't host the suggestions or the intro.
   - Suggestions still render as pills inside the scroll view whenever `!isConnecting && !isRunning && suggestions.length > 0` (`:8270`). The pill's name is the title only.
   - `EmptyState`, and with it the page's only `<h1>`, goes.

3. **Send and Stop are one unnamed icon button.**
   - `CopilotChatInput.SendButton` (`:1323`) toggles between the two icons and has no `aria-label`.
   - The textarea has only a placeholder (`:1444`). `ScrollToBottomButton` (`:8556`) has no name.
   - These need names through slots, both for axe (`button-name` is critical) and for the harness's `Send`/`Stop`/`Message` pins.

4. **The connect request goes to `POST {runtimeUrl}/agent/{agentId}/connect`**, which is `/api/copilotkit/agent/default/connect` (`@copilotkit/core/dist/index.mjs:1200`).
   - The client prepends empty `MESSAGES_SNAPSHOT`/`STATE_SNAPSHOT` events (`:1205-1215`).
   - `CopilotChat` connects in an effect keyed on `[resolvedThreadId, agent, …]`, aborts on cleanup (`:8964-9040`), and logs `console.error("CopilotChat: connectAgent failed")` on failure.

5. **Under StrictMode, connect runs twice.** The first connect is aborted. `B4AgentRunner` aborts its replay fetch when the subscriber unsubscribes (PR 1). `reduceTurns` restarts on a replayed `runId` (`turns.ts:430-435`), so the replay is idempotent.

6. **`useInterrupt` clears its pending card only on `RUN_STARTED`, a failed run, or unmount** (`:4985-5040`).
   - If `B4Activity` stays mounted across a switch to an empty thread, the previous thread's approval card leaks into it.
   - **Decision:** key `B4Activity` by thread id around the whole workbench. Its turns then reset on mount too (`useB4Turns` starts from `EMPTY_TURNS`).
   - Cost: the map, the sheet state and the Threads popover remount on every switch. The harness has to stop reading the rail row after its click (see §5).

7. **Media is lost twice over.**
   - `ToolStep.result` keeps only the text parts (`turns.ts:626-640`).
   - `eventsFromState` emits only the text of tool results and user messages (`turns-from-state.ts:142, 714`).
   - So `renderChart`'s SVG can't come from `step.result`, and after a reload both the chart and user image attachments are gone. The old `hydrate.ts`/`blocksToParts` did restore them, so this is a regression.
   - **Plan:** `ChartStepView` reads the image from `agent.messages` (the tool message with `toolCallId === step.id`, which subagent messages included). When it isn't there, it falls back to the step's text summary. Task 8 makes the replay carry media (decided: required, since a reload that drops charts and attachments regresses the current hydrate), and `ChartStepView` then reads `step.parts` first.

8. **Duplicate CopilotKit copies.** `realpath` shows different `.pnpm` copies for `examples/navlog/web` and `packages/ag-ui`:
   - `@copilotkit/runtime`: `…_2a670b9…` vs `…_80df67c…`
   - `@copilotkit/react-core`: `…_bca7319…` vs `…_b4f59d3…`

   Inside Next, `@b4run/ag-ui/copilotkit` would import a second react-core, so its `useAgent` and `useInterrupt` would read a different context than `<CopilotKit>` provides. Task 1 has to fix and pin this before anything else.

9. **Header forwarding opens a spoofing path.** CopilotKit forwards inbound `x-*` headers into `AgentRunnerConnectRequest.headers` (`runtime/dist/v2/runtime/handlers/sse/connect.mjs:16`, `header-utils`). PR 1's runner spreads those into its fetch. The route's fetch must therefore delete any inbound `x-b4-visitor`/`x-internal-token` before it sets the real ones.

10. **First-message titling disappears.**
    - Today `AppShell.send` calls `onUserMessage` → `source.touch(title)`, and `CopilotChat` sends on its own.
    - Without a fix, threads stay "New conversation", and W7 (`findPersistedThreadId`) and the rail break.

11. **CopilotChat's dark mode is `.dark`-only.** Its tokens are declared on `[data-copilotkit]` / `.dark [data-copilotkit]` (unlayered), and the `cpk:dark:` utilities compile to `:is(.dark *)`. Navlog's dark theme is a media query, so the chat needs a `.dark` class driven from `prefers-color-scheme`.

12. **The approval card title reads badly for `fileFlightPlan`.**
    - The card reads "The agent wants to <running label>" (`B4Activity.tsx:173-176`).
    - `fileFlightPlan`'s `display.running` is "Filing N738ZU …" (`examples/navlog/server/src/tools/fileFlightPlan.ts:38-42`), so the card would say "wants to filing …".
    - Rephrase it as an infinitive, in the server example and the server template together, since server parity is byte-for-byte.

---

## 1. Inventory

### Components (`app/components/`)

| File (+ test) | Verdict | Reason |
|---|---|---|
| `AppShell.tsx` (+test) | CHANGE | Keeps the probe and ConnectScreen, the `onError` banner, drop notices, title-on-first-message, and the thread-switch `pendingInterrupts` clear. Deletes the hydrate effect, `withRestoredPlan`, `send`/`stop`, `hydratedPendingCount`, `useSubagentRuns`, and the agent-swap message carry (`:388-409`). It now renders `<B4Activity key={threadId}>` around a new `ThreadWorkbench`. |
| `ChatDock.tsx` (+test) | CHANGE | Drop the `composer` prop. Add `banner` and `notices` slots. The brand `<span>` becomes `<h1>` (the page's only h1 now that EmptyState is gone). Header, Threads and StatusBadge stay. |
| `WorkbenchLayout.tsx` (+test) | CHANGE | `dock`+`composer` become `chat`. Exports `SheetControlContext` (`openSheet()`: `setSheetOpen(true)` on desktop, `selectTab("navlog")` on a phone). |
| `Transcript.tsx` (+test) | DELETE | CopilotChat's message view replaces it. |
| `Composer.tsx` (+test) | DELETE | Replaced by CopilotChat's input with the `attachments` config. |
| `ToolCallCard.tsx` (+test) | DELETE | The kit's `Step`/`StepDetail`. |
| `NavlogCard.tsx` (+test) | DELETE | Replaced by `StepViews.NavlogStepView`. |
| `PlanCard.tsx`, `activity-renderers.tsx` (+test) | DELETE | The kit's `PlanStep`. `renderActivityMessages` comes off `page.tsx`. |
| `PermissionPrompt.tsx`, `PermissionInterrupt.tsx`, `HydratedInterrupts.tsx` (+tests) | DELETE | `B4Activity`'s `ApprovalCard`; a parked approval restores from the replay's `RUN_FINISHED{interrupt}`. |
| `EmptyState.tsx` | DELETE | Welcome screen is suppressed (finding 2). Pills come from CopilotChat. |
| `MediaParts.tsx` (+test) | KEEP | Reused by `ChartStepView` to draw the image part. |
| `RunError.tsx` | KEEP | Becomes the dock banner (`ChatDock.banner`), with an optional Retry. |
| `ConnectScreen.tsx` (+test) | KEEP | Probe unchanged. |
| `DemoSuggestions.tsx` | KEEP | `useConfigureSuggestions`; CopilotChat reloads it itself. |
| `MemoryPanel.tsx` (+test), `ThreadRail.tsx` (+test) | KEEP | Out of scope. |
| `NavlogSheet`, `NavlogTable`, `FlightPlanBlock`, `VerdictCard`, `PlanningBrief`, `WeatherStrip`, `RouteMap` (+tests) | KEEP | Pure views; their inputs now come from turns. |
| `ui.ts` | KEEP | Used by ConnectScreen, MemoryPanel and RunError. |
| **NEW** `NavlogChat.tsx` (+test) | ADD | `CopilotChat` with the B4 slots, named input buttons, attachments, and input disabled while awaiting. |
| **NEW** `StepViews.tsx` (+test) | ADD | `ChartStepView`, `NavlogStepView`, `NAVLOG_STEP_RENDERERS`. |
| **NEW** `DropNotices.tsx` (+test) | ADD | `dropNoticeText` and the `<details>` notice, moved out of Transcript (now dock-level, cleared on switch). |

### Libraries (`app/lib/`)

| File (+ test) | Verdict | Reason |
|---|---|---|
| `hydrate.ts` (+test) | DELETE | Restore is server-side now. |
| `transcript.ts` (+test) | DELETE | `titleFor` and `userText` move to `thread-source.ts`; `DropNotice`/`DroppedPartLike` move to `DropNotices.tsx`. |
| `stick-to-bottom.ts` (+test) | DELETE | CopilotChat's ScrollView (use-stick-to-bottom plus ScrollToBottomButton). |
| `tool-presentation.ts` (+test) | DELETE | Only ToolCallCard and PermissionPrompt imported it. |
| `thread-source.ts` (+test) | CHANGE | Drop `hydrate`, `pendingInterrupts`, `ParkedInterrupt`, `readParkedInterrupts` and the `PermissionPrompt` import. Add `titleFor`. |
| `parts.ts` (+test) | CHANGE | Drop `blocksToParts` (hydrate-only). Keep `partsOf`, `mediaParts`, `dataUrl`. |
| `navlog-selectors.ts` (+test), `weather-selectors.ts` (+test) | CHANGE | Selectors over `TurnsView` (§2). |
| `assistant-text.ts` (+test) | KEEP | `stripToolEchoes` (now in `transformMessages`) and `parsePlanningAnswer`. |
| `proxy-allowlist.ts` (+test) | CHANGE | Drop the two thread rows (§3). |
| `brief-contract.test.ts` | CHANGE | Follows the selector signatures. |
| `format`, `navlog-types`, `route-geometry`, `guarded-request`, `rate-limit`, `proxy-guard`, `visitor-context`, `use-hydrated`, `use-media-query` | KEEP | Unchanged. |

### Other files

| File | Verdict | Reason |
|---|---|---|
| `page.tsx` | CHANGE | Drop the `ToolCallCard`/`NavlogCard` registrations and `renderActivityMessages`. Keep `CopilotChatConfigurationProvider` and `DemoSuggestions`. |
| `layout.tsx` | CHANGE | `<html lang="en" data-b4-theme="auto" suppressHydrationWarning>`, plus an inline script that sets `.dark` from `matchMedia`. |
| `theme.css` | CHANGE | Token additions (§4). |
| `api/copilotkit/[...path]/route.ts` (+test) | CHANGE | §3. |
| `api/b4/[...path]/route.ts` (+test) | CHANGE | Retarget tests from `threads/t1/state` (`route.test.ts:34-38, 93-134`) to the `memory/candidates` paths. Update the comment at `:41`. |

### Features: how each is covered

| Feature today | Handled by |
|---|---|
| Image attachments in the composer | `CopilotChatProps.attachments: AttachmentsConfig` (`{enabled, accept, maxSize, onUploadFailed}`, `@copilotkit/shared/dist/attachments/types.d.mts:28`). Values: `enabled: capabilities?.multimodal?.input?.image === true`, `accept: "image/png,image/jpeg,image/gif,image/webp"`, `maxSize: 4*1024*1024`. User bubbles render media themselves (`CopilotChatUserMessage` → `getMediaParts`, `:6685`). |
| Content-parts-dropped notice | Kept outside the chat: the AppShell `onCustomEvent` subscription feeds `DropNotices` in the dock. |
| Run-error banner | Kept: `copilotkit.subscribe({onError})` with `RUN_ERROR_TITLES`. `agent_connect_failed` now reads "Couldn't load this conversation"; Retry bumps a `connectNonce` appended to the `B4Activity` key. |
| ConnectScreen probe | Kept as is. `isProxyUnreachableError` goes (there is no client hydrate any more). |
| "Restored history" note | Deleted. The replay restores subagents and the plan, so the note would now be untrue. |
| Status badge (running / awaiting) | Kept: `agent.isRunning` → "running"; `turns.turns.at(-1)?.status === "awaiting"` → "awaiting approval". |
| Verdict card, planning brief, assistant brief | Kept in the sheet; the inputs come from the selectors in §2. |
| Suggestions and empty state | `useConfigureSuggestions` pills in CopilotChat's scroll view (`hasSuggestions`, `:8270`). EmptyState and its intro copy are removed; the h1 moves to the dock brand. |
| Stick-to-bottom, "Jump to latest" | CopilotChat's `ScrollView`, with `scrollView={{ scrollToBottomButton: { "aria-label": "Jump to latest" } }}`. |
| Stop button | CopilotChat's `effectiveStopHandler` (`:9378`) on the shared send button, named through the slot. |
| "Working…" indicator | CopilotChat's `cursor` slot while running. |
| Input blocked while awaiting approval | `input={{ textArea: { disabled: awaiting, placeholder } }}` in NavlogChat. |
| Tool-echo stripping | `messageView.transformMessages = (m) => stripEchoes(mergeTurnMessages(m))`. |
| Thread titling | AppShell effect: when the active thread is untitled and `agent.messages` has a user message, call `onUserMessage(titleFor(content))`. |

---

## 2. Selectors over turns

All of these live in the existing lib files. They are pure, and they memoize on strings.

```ts
// lib/navlog-selectors.ts
import type { TurnsView } from "@b4run/ag-ui/view"
export interface ToolResultRef { readonly id: string; readonly result: string }
/** Newest turn first, newest step first, recursing into subagent turns; done tool steps named `name` whose result passes `accept`. */
export function latestToolResult(view: TurnsView, name: string, accept: (result: string) => boolean): ToolResultRef | null
/** The latest done computeNavlog step whose result parses (a failed call leaves the last good plan up). */
export function latestNavlogResult(view: TurnsView): ToolResultRef | null
/** Last non-empty assistant prose after the tool message `toolCallId`, before the next user message. */
export function navlogAnswerText(messages: readonly MessageLike[], toolCallId: string): string
export function isAwaitingApproval(view: TurnsView): boolean // last turn status "awaiting"
// keep parseNavlog; delete latestNavlogText, latestNavlog, lastAssistantText

// lib/weather-selectors.ts
/** Latest `weather` subagent step with status "done" (any depth) whose result (string, or a JSON-encoded string unwrapped once) parses to ≥1 airport. */
export function latestWeatherBriefText(view: TurnsView): string | null
// delete SubagentRunLike, latestWeatherBrief(runs), WeatherMessageLike, weatherBriefTextFromMessages, isWeatherTask
```

A done subagent's status is `"done"`, not `"completed"`. Its result is the `SUBAGENT_FINISHED.result` text, and the replay sets it (`turns-from-state.ts:682-686`).

The brief stays anchored by message id because `TurnView.text` merges every prose message in the turn, including the preamble. `navlogAnswerText` reads `useAgent().agent.messages`, which the replay restores.

`ThreadWorkbench` (inside `B4Activity`) does the wiring:

```tsx
const { turns } = useB4ActivityContext()
const navlogRef = latestNavlogResult(turns)
const navlog = useMemo(() => (navlogRef ? parseNavlog(navlogRef.result) : null), [navlogRef?.result])
const weatherText = latestWeatherBriefText(turns)
const brief = useMemo(() => (weatherText ? parseWeatherBrief(weatherText) : null), [weatherText])
const assistantBrief = navlogRef ? navlogAnswerText(agent.messages, navlogRef.id) : ""
```

Tests are rewritten over `TurnsView` fixtures built with `reduceTurns`: a nested weather subagent, a failed `computeNavlog` after a good one, a JSON-encoded result, and an answer anchored after the result rather than the preamble.

---

## 3. Route wiring and the allowlist

`app/api/copilotkit/[...path]/route.ts`:

```ts
import { B4HttpAgent } from "@b4run/ag-ui/client"
import { B4AgentRunner } from "@b4run/ag-ui/copilotkit-runtime"
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"
// …guardRequest, guardConfigFromEnv, upstreamHeaders, visitorContext as today

const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"
const agUiUrl = `${b4Url}/agui/${encodeURIComponent("/navlog#agent")}`

/**
 * Every upstream call (the run, `/info`'s capabilities read, and the runner's
 * replay of `/threads/:id/events`) carries THIS request's visitor id and, when
 * deployed, the internal token. CopilotKit forwards inbound `x-*` headers into
 * the runner's connect request, so a browser-sent `x-b4-visitor` is dropped
 * here before the real one is set.
 */
const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.delete("x-b4-visitor")
  headers.delete("x-internal-token")
  const visitorId = visitorContext.getStore()?.visitorId
  if (visitorId !== undefined) {
    const { internalToken } = guardConfigFromEnv()
    for (const [name, value] of Object.entries(upstreamHeaders({ internalToken, visitorId }))) headers.set(name, value)
  }
  return fetch(input, { ...init, headers })
}) as typeof fetch

const agent = new B4HttpAgent({ url: agUiUrl, fetch: guardedFetch })
const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: agent },
    runner: new B4AgentRunner({ url: b4Url, fetch: guardedFetch }),
  }),
  basePath: "/api/copilotkit",
})
// guarded(), GET, POST, runtime = "nodejs", dynamic = "force-dynamic" unchanged
```

New cases in `route.test.ts`. The fake server answers `GET /threads/t-1/events` with `{events:[RUN_STARTED{input…}, RUN_FINISHED], warnings:[], truncated:false}` and `404` for `t-404`.
- A `POST /api/copilotkit/agent/default/connect` with body `{threadId:"t-1",runId:"c",messages:[],tools:[],context:[],state:{},forwardedProps:{}}` and the cookie produces one upstream `GET /threads/t-1/events` with `x-b4-visitor` (plus the token when one is set). The SSE body contains `RUN_STARTED`. This pins that `AsyncLocalStorage` survives `observableFactory`.
- Connecting to `t-404` gives a 200 stream with no `RUN_STARTED`.
- A browser `x-b4-visitor: v-attacker` header reaches neither the replay nor the run upstream.
- `test/security-dependencies/copilotkit-v2-runtime.test.ts` still passes. Its fixture may need a GET `/threads/*/events` → 404 branch.

`lib/proxy-allowlist.ts:31-35` removes both thread rows and their comment:

```ts
const ALLOWED: readonly AllowedRoute[] = [
  // The dev server's entire memory surface — these three and no more.
  { method: "GET", shape: ["memory", "candidates"] },
  { method: "POST", shape: ["memory", "candidates", null, "approve"] },
  { method: "POST", shape: ["memory", "candidates", null, "reject"] },
  // Thread history is NOT proxied: the CopilotKit route's B4AgentRunner reads
  // /threads/:id/events server-to-server on `connect`.
]
```

In `proxy-allowlist.test.ts`:
- `:20-24` becomes asserts that `state`/`pending_interrupts` are `null`.
- The segment-safety and encoding cases (`:42-56`) move to `["memory","candidates",<seg>,"approve"]` with POST.

---

## 4. Theme tokens

Insert after the `:root` mapping block in `theme.css` (`:72-78`):

```css
:root {
  --b4-activity-surface-alt: var(--wb-rail);
  --b4-activity-running: var(--wb-route);
  --b4-activity-running-bg: color-mix(in srgb, var(--wb-route) 10%, var(--wb-surface));
  --b4-activity-complete: var(--wb-go);
  --b4-activity-failed: var(--wb-nogo);
  --b4-activity-failed-bg: var(--wb-nogo-bg);
  --b4-activity-primary: var(--wb-text);
  --b4-activity-on-primary: var(--wb-surface);
}
/* CopilotChat's shadcn tokens (declared unlayered on [data-copilotkit] and
   .dark [data-copilotkit]). (0,2,0) and imported after the CopilotKit sheet in
   layout.tsx, so these win in both schemes; :root rather than .wb-dock so
   Radix tooltip/menu portals match too. */
:root [data-copilotkit] {
  --background: var(--wb-surface); --foreground: var(--wb-text);
  --card: var(--wb-surface); --card-foreground: var(--wb-text);
  --popover: var(--wb-surface); --popover-foreground: var(--wb-text);
  --primary: var(--wb-text); --primary-foreground: var(--wb-surface);
  --secondary: var(--wb-rail); --secondary-foreground: var(--wb-text);
  --muted: var(--wb-rail); --muted-foreground: var(--wb-muted);
  --accent: var(--wb-rail); --accent-foreground: var(--wb-text);
  --destructive: var(--wb-chat-danger); --border: var(--wb-border);
  --input: var(--wb-border); --ring: var(--wb-accent-from); --radius: var(--wb-radius);
}
.wb-dock .copilotKitChat { background: transparent; }
```

Also:
- Update the comment block at `theme.css:7-9`, which says the status colors "deliberately stay defined" in the package.
- `layout.tsx` gets an inline `<script>` that runs `document.documentElement.classList.toggle("dark", matchMedia("(prefers-color-scheme: dark)").matches)` and listens for changes. This brings in CopilotKit's `cpk:dark:` utilities (`:is(.dark *)`).
- `ChatDock.tsx:39` falls back to `#2563eb`; that becomes `var(--b4-activity-running)` (now mapped).

---

## 5. Harness changes

### Pins that break, and their replacements

| Location | Today | Replacement |
|---|---|---|
| `docs/brand/demo/capture.mjs:815,828`, `:821-824` | textbox "Message"; buttons "Stop"/"Send" | Keep the pins; NavlogChat names them (finding 3). |
| `capture.mjs:831-865` `restoreWorkbenchThread` | waits for `/api/b4/threads/:id/state`; `row.getAttribute("aria-current")`; `getByText(tool)` | See below. |
| `capture.mjs:994-1003` `runScenario` | `getByText(tool, {exact})` for each tool | After `waitForWorkbenchRunCompletion`: `expandLatestTurn(page)`, then count `li.b4-step[data-kind="tool"]` ≥ `tools.length`, then the answer text. |
| `capture.mjs:1352, 1373`; `capture.d.mts:18-27` | `stateUrl` | `connectUrl`. |
| `test/harness/workbench-page.ts:166-180` | tolerates the 404 hydrate probe on `/state` and `/pending_interrupts` | Delete it (no client probes any more); `workbench-page.test.ts:171-188` follows. |
| `workbench-suggestions.ts:139-149` | comment: name = title + message (EmptyState) | The pill's name is the title; the `^title` regex still matches. Update the comment. |
| `workbench-suggestions.ts:163-194` (plan) | legacy `details` "Plan · 1/4 complete", "performance · completed · 1 tool", `label=Subagent tools`, tool-name text | See below. |
| `workbench-suggestions.ts:208-215` (gate) | `getByRole("alert").filter({hasText:"fileFlightPlan"})` | `main.locator('.b4-approval[role="alert"]')`, exactly one. Tab to "Allow once" and press Enter (keyboard pass). Wait for it to be hidden. |
| `workbench-suggestions.test.ts:248-290` `GOLDEN_CALLS` | the legacy locator list | Rewritten to the strings the new journey emits (regenerate by running the fake-page test and reviewing the diff). |
| `test/harness/workbench-browser.test.ts:74-77` | fake `stateUrl` | `connectUrl`. |
| `docs/brand/demo/demo.test.mjs:2137-2209` | restore unit tests on `/state` | Assert the connect predicate and the new DOM waits. |
| `test/generated/run-generated-navlog-activation.test.ts:1776-1797` (W2) | `GET /api/b4/threads/:safe/state` → 200 with the POH citation; absent → 404 | `POST /api/copilotkit/agent/default/connect {threadId: safeThreadId,…}` returns SSE whose events include `RUN_STARTED.threadId === safeThreadId` and a `TOOL_CALL_RESULT`/`TEXT_MESSAGE_CONTENT` containing "[poh/cruise-performance.md, Figure 5-7]". An absent thread gives 200 with zero `RUN_STARTED`. Add `/api/b4/threads/:safe/state` → 403 to W1. Reuse `postAgui` if it doesn't enforce single-run verification; otherwise add a `postConnect` helper next to it. |
| same file `:1839-1844` (W4) | `webState` `/state` 200 | Connect the web thread: `RUN_STARTED.input.messages[0].content === WEB_PROMPT`. |
| `examples/navlog/web/e2e/copilotkit-v2.spec.ts:41-43` | the first request is `/info`; no POST `/api/copilotkit` | Keep both. Add: a POST to `/api/copilotkit/agent/default/connect` was made. If connect races `/info`, drop the `[0]` ordering in favour of `toContainEqual`. |

### Restore (W7 and capture)

```js
const connectPath = "/api/copilotkit/agent/default/connect"
const connected = page.waitForResponse((r) => {
  const u = new URL(r.url())
  if (r.request().method() !== "POST" || u.origin !== origin || u.pathname !== connectPath) return false
  try { return JSON.parse(r.request().postData() ?? "{}").threadId === threadId } catch { return false }
}, { timeout: 120_000 })
// reload → open Threads → click row(prompt) → (workbench remounts; popover closes)
await page.getByRole("heading", { level: 2, name: prompt, exact: true }).waitFor({ state: "visible", timeout: 60_000 })
const [response] = await Promise.all([connected, interaction])
if (!response.ok()) throw new Error(`Thread restoration failed with HTTP ${response.status()}`)
const main = page.getByRole("main")
await main.getByText(prompt, { exact: true }).waitFor(VISIBLE)
const turn = main.locator('section.b4-turn[data-state="done"]')
await turn.first().waitFor(VISIBLE); if ((await turn.count()) !== 1) throw …
await turn.locator("button.b4-turn__summary").click()           // a restored turn starts folded
if ((await turn.locator("button.b4-turn__summary").getAttribute("aria-expanded")) !== "true") throw …
const steps = turn.locator('li.b4-step[data-kind="tool"]'); if ((await steps.count()) !== tools.length) throw …
await main.getByText(answer, { exact: true }).last().waitFor(VISIBLE)
return { connectUrl: response.url() }
```

The heading replaces the `aria-current` check, because the row detaches when the workbench remounts (finding 6). Under StrictMode the predicate may match the aborted first connect; that's acceptable, because the DOM assertions are the evidence.

### Plan journey (W8)

Inside `main`:
- `section.b4-turn` count is 1, then expand the turn.
- `li.b4-step[data-kind="plan"]` exactly one, with `hasText: "Made a plan"`.
- `li.b4-step[data-kind="subagent"]` filtered to `hasText: "performance finished"` exactly one. Click its `.b4-step__line`, check `aria-expanded="true"`, and find a nested `li.b4-step[data-kind="tool"]` inside `.b4-step__children`.
- `li.b4-step[data-kind="tool"]` that are direct children of `.b4-turn__steps` (not inside `.b4-step__children`): at least 2 (computeNavlog and writeFile), plus `.b4-step__detail` after opening the computeNavlog step showing the button "See the navlog sheet".
- The reply text exactly once.

### Accessibility

- Add `"@axe-core/playwright"` (pin the current 4.x) to the **root** `devDependencies` (`package.json:72-90`), where `@playwright/test 1.62.1` lives and the harness runs.
- New `test/harness/workbench-a11y.ts`:

```ts
export async function assertNoSeriousAxeViolations(page: Page, include = 'section[aria-label="Chat"]') {
  const { violations } = await new AxeBuilder({ page }).include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  if (bad.length > 0) throw new Error(`axe: ${bad.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`)
}
export async function tabUntilFocused(page: Page, target: Locator, maxTabs = 30) { /* press Tab; target.evaluate(el => el === document.activeElement) */ }
```

`AxeBuilder` is injectable through deps, the same way `chromium` is, so the unit tests stay browserless.

- **W7**, after restore:
  - Run axe on the dock.
  - Keyboard pass: focus `.b4-turn__summary` (Tab to it from the textbox with Shift+Tab), press Enter, and check `aria-expanded` flips.
  - Tab to the first `li.b4-step .b4-step__line`, press Enter, and check its `aria-expanded="true"`.
- **W8 gate:** `tabUntilFocused(page, allowOnce)`, then Enter; this replaces the click. Run axe with the approval card on screen before answering.

---

## 6. Template parity

- Mirror every changed, added and deleted file under `web/app/**` (`WEB_PARITY_ROOTS`, `templates.test.ts:25-33`).
- Add `rxjs` (`7.8.1`, which `@copilotkit/runtime` uses) to `examples/navlog/web/package.json` and `templates/app-navlog/web/package.json.template`. The runner entry imports it as an optional peer.
- Server: `fileFlightPlan.ts` `display.running` in both the server example and the server template.
- Counts at `templates.test.ts:519-524`:
  - `.test.ts.template`: **17 → 13** (removes hydrate, transcript, stick-to-bottom, tool-presentation).
  - `.test.tsx.template`: **20 → 15** (removes Composer, HydratedInterrupts, NavlogCard, PermissionInterrupt, PermissionPrompt, ToolCallCard, Transcript, activity-renderers; adds NavlogChat, StepViews, DropNotices).
- `template-no-playwright.test.ts` is unaffected: axe goes in root devDeps, not the template.

---

## Tasks

### Task 1: one CopilotKit instance, and export the context hook

**Files:**
- `packages/ag-ui/src/copilotkit/index.ts`
- `packages/ag-ui/test/copilotkit/public-api.test.ts`
- `apps/web/content/docs/api/ag-ui.mdx` (rows near `:210-216`)
- `examples/navlog/web/next.config.mjs`
- `examples/navlog/web/vitest.config.ts`
- `.changeset/activity-adopt-navlog.md`

- [ ] 1. Export `useB4ActivityContext` and `type B4ActivityContextValue`. Add `"useB4ActivityContext"` to the expected key list. Add a docs row: "The turns, labels and `renderStep` `B4Activity` provides, for host UI outside the chat (a map, a sheet); throws outside `B4Activity`."
- [ ] 2. Prove the duplicate:
  - `realpath examples/navlog/web/node_modules/@copilotkit/{react-core,runtime} packages/ag-ui/node_modules/@copilotkit/{react-core,runtime}`
  - `pnpm why @copilotkit/react-core -r`
- [ ] 3. Fix it at the source if you can: align the ag-ui devDeps that drive the peer hash (`@types/react`, `zod`) so pnpm resolves one copy. If that isn't possible, add `turbopack.resolveAlias` and a webpack `resolve.alias` in `next.config.mjs` that point `@copilotkit/react-core`, `@copilotkit/runtime`, `react` and `rxjs` at the app's own copies, plus `resolve.dedupe` with the same list in `vitest.config.ts`. Keep the template's config identical, because `next.config.mjs` is in parity scope.
- [ ] 4. `pnpm --filter @b4run/ag-ui build && pnpm --filter @b4run/ag-ui exec vitest --run test/copilotkit` → PASS.
- [ ] 5. Commit `feat(ag-ui): export useB4ActivityContext for host UI outside the chat`.

### Task 2: route, runner and allowlist

**Files:**
- `app/api/copilotkit/[...path]/route.ts` (+ test)
- `app/lib/proxy-allowlist.ts` (+ test)
- `app/api/b4/[...path]/route.test.ts`
- both `package.json` files (`rxjs`)
- `test/security-dependencies/copilotkit-v2-runtime.test.ts` if needed

- [ ] 1. Write the §3 tests; they fail.
- [ ] 2. Implement §3.
- [ ] 3. `pnpm --filter @b4-example/navlog-web exec vitest --run app/api app/lib/proxy-allowlist.test.ts && pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts` (or whatever config that directory uses) → PASS.
- [ ] 4. Commit `feat(navlog-web): restore threads through B4AgentRunner; stop proxying thread state`.

### Task 3: selectors over turns

**Files:** `lib/navlog-selectors.ts`, `lib/weather-selectors.ts`, `lib/brief-contract.test.ts`, and their tests.

- [ ] 1. Write the §2 tests first.
- [ ] 2. Implement.
- [ ] 3. `pnpm --filter @b4-example/navlog-web exec vitest --run app/lib` → PASS.
- [ ] 4. Commit.

### Task 4: step views and the chat

**Files:** create `components/StepViews.tsx`, `components/NavlogChat.tsx`, `components/DropNotices.tsx`, plus tests.

- [ ] 1. `StepViews.tsx`:

```tsx
export function NavlogStepView({ step }: { readonly step: ToolStep }) {
  const navlog = step.status === "done" && step.result ? parseNavlog(step.result) : null
  const { openSheet } = useContext(SheetControlContext)
  if (navlog === null) return <StepDetail args={step.args} result={step.result} />
  return (<p className="tabular-nums">{navlog.totals.distanceNm} nm · {navlog.legs.length} leg{navlog.legs.length === 1 ? "" : "s"} · {formatGal(navlog.totals.fuelGal)} gal{" "}
    <button type="button" className="wb-focus underline" onClick={openSheet}>See the navlog sheet</button></p>)
}
export function ChartStepView({ step }: { readonly step: ToolStep }) {
  const { agent } = useAgent()
  const tool = agent.messages.find((m) => m.role === "tool" && m.toolCallId === step.id)
  const media = tool ? mediaParts(partsOf(tool.content)) : []
  return media.length > 0 ? <MediaParts parts={media} /> : <StepDetail args={step.args} result={step.result} />
}
export const NAVLOG_STEP_RENDERERS: StepRenderers = {
  computeNavlog: ({ step }) => <NavlogStepView step={step} />,
  renderChart: ({ step }) => <ChartStepView step={step} />,
}
```

- [ ] 2. `NavlogChat.tsx`, rendered inside `B4Activity`:

```tsx
export function NavlogChat({ threadId, canAttachImages }: { threadId: string; canAttachImages: boolean }) {
  const slots = useB4ChatSlots()
  const { turns } = useB4ActivityContext()
  const { agent } = useAgent()
  const awaiting = isAwaitingApproval(turns)
  return (<CopilotChat threadId={threadId}
    messageView={{ ...slots.messageView, transformMessages: (m) => stripEchoMessages(slots.messageView.transformMessages(m)) }}
    input={{ textArea: { "aria-label": "Message", disabled: awaiting, placeholder: awaiting ? "Answer the approval above to continue" : "Ask the planner…" },
             sendButton: { "aria-label": agent.isRunning ? "Stop" : "Send" }, addMenuButton: { "aria-label": "Add attachments" } }}
    scrollView={{ scrollToBottomButton: { "aria-label": "Jump to latest" } }}
    attachments={{ enabled: canAttachImages, accept: ATTACHABLE_IMAGE_TYPES.join(","), maxSize: 4 * 1024 * 1024 }}
    labels={{ chatDisclaimerText: "" }} className="min-h-0 flex-1" />)
}
```

`stripEchoMessages` maps assistant string content through `stripToolEchoes`, and returns the same array when nothing changed.

- [ ] 3. Tests:
  - Render the views with `ToolStep` fixtures, and with a mocked `useAgent` returning a tool message whose content holds an image part.
  - `NavlogChat` with `vi.mock("@copilotkit/react-core/v2")` capturing `CopilotChat` props: slot names, disabled while awaiting, attachments gated.
- [ ] 4. Run `pnpm --filter @b4-example/navlog-web exec vitest --run app/components/StepViews.test.tsx app/components/NavlogChat.test.tsx app/components/DropNotices.test.tsx`, then commit.

### Task 5: shell, dock, layout and page; delete the legacy files

**Files:** `AppShell.tsx`, `ChatDock.tsx`, `WorkbenchLayout.tsx`, `page.tsx`, `lib/thread-source.ts`, `lib/parts.ts` (and their tests). Delete the §1 DELETE set.

- [ ] 1. In `AppShell`, render:

```tsx
<B4Activity key={`${activeThreadId}:${connectNonce}`} renderStep={NAVLOG_STEP_RENDERERS}>
  <ThreadWorkbench …/>
</B4Activity>
```

Render `NavlogChat` only when `activeThreadId !== undefined`. Keep the `pendingInterrupts = []` clear on thread change. Add the titling effect.

- [ ] 2. Rewrite `AppShell.test.tsx` around mocked `CopilotChat`/`B4Activity`. Cover:
  - the probe;
  - `onError` titles, including `agent_connect_failed` with Retry;
  - titling once;
  - a switch remounts (the key changes);
  - drop notices clear on switch;
  - the status badge goes to awaiting from turns.
- [ ] 3. Run `pnpm --filter @b4-example/navlog-web test && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web lint`. `grep -rn "hydrate\|useSubagentRuns\|SubagentPanel\|planActivityContentSchema\|pending_interrupts" examples/navlog/web/app` must come back empty.
- [ ] 4. Commit `feat(navlog-web): the chat dock is CopilotChat inside B4Activity`.

### Task 6: theme, layout and server label

**Files:** `theme.css`, `layout.tsx`, `ChatDock.tsx:39`, `examples/navlog/server/src/tools/fileFlightPlan.ts` and its template twin.

- [ ] 1. Apply §4.
- [ ] 2. Change `running` to `` `file ${item7} ${dep} to ${dest}` ``. Grep the server tests and evals for "Filing" and update them.
- [ ] 3. Check by eye in `pnpm --filter @b4-example/navlog-web dev`, in both OS schemes.
- [ ] 4. Commit.

### Task 7: template parity

**Files:** everything under `packages/devkit/templates/app-navlog/web/**` and the server tool; `packages/devkit/test/templates.test.ts:519-524`.

- [ ] 1. Mirror the files. Keep the `.template` suffix on tests.
- [ ] 2. `pnpm --filter @b4run/devkit exec vitest --run test/templates.test.ts test/template-no-playwright.test.ts` → PASS.
- [ ] 3. Commit.

### Task 8: replay media (required)

**Files:** `packages/ag-ui/src/view/turns-from-state.ts`, `packages/ag-ui/src/view/turns.ts`.

- [ ] Move navlog's `blocksToParts` into `@b4run/ag-ui/view`.
- [ ] In `eventsFromState`, emit `content: ContentPart[]` for user and tool messages that carry media blocks.
- [ ] Add `ToolStep.parts?: readonly ContentPart[]`, kept by the reducer for non-text parts, so `ChartStepView` can read `step.parts`.
- [ ] Tests go in `test/view/events-from-state.test.ts`.
- [ ] Without this task, a reload loses charts and user images (finding 7). Document that in the README.

### Task 9: harness

**Files:**
- `docs/brand/demo/capture.mjs`, `capture.d.mts`, `demo.test.mjs`
- `test/harness/workbench-browser.ts`, `workbench-suggestions.ts`, `workbench-page.ts`, and their tests
- new `test/harness/workbench-a11y.ts` (+ test)
- `test/generated/run-generated-navlog-activation.test.ts`
- root `package.json`, `pnpm-lock.yaml`
- `examples/navlog/web/e2e/copilotkit-v2.spec.ts`

- [ ] 1. Add the root devDep. Run `pnpm install`. `git diff --stat pnpm-lock.yaml` must show only the root importer plus the new axe packages.
- [ ] 2. Apply the §5 table. Regenerate `GOLDEN_CALLS` and review the diff.
- [ ] 3. Run:
  - `pnpm test:brand-demo`
  - `pnpm exec vitest --run test/harness`
  - `pnpm --filter @b4-example/navlog-web test:e2e`
  - `pnpm verify:harness:framework` (W1–W8 run inside the generated-app activation)

  All PASS.
- [ ] 4. Commit.

### Task 10: docs, README and changeset

- [ ] 1. Rewrite the component table and the history/permission sections in:
  - `examples/navlog/web/README.md` (`:49-121`, `:140-141`, `:204-221`)
  - `packages/devkit/templates/app-navlog/web/README.md` (`:76-139`)
- [ ] 2. Rewrite `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`:
  - `:17` (composer) → the CopilotChat input.
  - `:89-130` → B4Activity and NavlogChat, with restore by `B4AgentRunner`.
  - `:165-175` → media via `ChartStepView`.
  - `:220-232` → the kit.
  - `:254` → the allowlist without thread rows.
  - Keep the "Related" `/docs/memory/long-term` link (`check-docs.mjs:3882`).
  - Touch `recipes/flight-planner.mdx` only where it names the removed files.
  - Update the restore row in `docs/brand/demo/evidence-matrix.md`.
- [ ] 3. Changeset: `"@b4run/ag-ui": patch` (the export) and `"@b4run/devkit": patch` (the template). Follow `.changeset/agui-multimodal-example.md` for whether the example package gets listed.
- [ ] 4. Run `node scripts/check-docs.mjs && pnpm --dir apps/web seo:lastmod` and commit.

### Task 11: full gate

- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs && pnpm pack:check`
- [ ] Open the PR "feat: navlog on CopilotChat (activity adopt, PR 2/3)".

**Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → (8) → 9 → 10 → 11. Task 9 needs Tasks 5–7 because the harness scaffolds the template.

---

## Risks

1. **Duplicate React context** (finding 8). The most likely first failure is "useAgent must be used within CopilotKitProvider", or approvals that never render. Task 1 has to land first, verified in `next dev` and in vitest.
2. **Thread switching.** The keyed remount resets the map, the sheet and the Threads popover. If the remount cost is unacceptable, the alternative is a connector change: `B4Activity` takes a `threadId`, resets its turns, and clears `useInterrupt` through an inner keyed provider.
   - Also: `pendingInterrupts` on the shared agent is not cleared by an empty connect (explicit-thread path, `:8964`). Keep the manual clear.
3. **StrictMode double connect.** There are two connect POSTs in dev, and the first is aborted. The harness predicate filters by thread id and relies on DOM assertions. The runner must not log the aborted fetch as an error, or the harness's console-error gate trips (PR 1's `controller.signal.aborted` guard covers this).
4. **Hydration.** The inline `.dark` script and the `data-b4-theme` attribute need `suppressHydrationWarning` on `<html>`.
   - Render `NavlogChat` only after `activeThreadId` resolves. Otherwise `CopilotChat` mints a random UUID thread (`:8828`) and connects to it.
5. **Attachments.** CopilotChat's `accept` filter may not cover paste or drop (check `useAttachments` with `matchesAcceptFilter`). Task 8 keeps media across a reload. The `/agui` body limit (8 MiB) still argues for the 4 MiB cap.
6. **Runner on Vercel and Next.**
   - The runner must stay a module-level singleton, so that `isRunning` sees in-process runs.
   - Rejoining a run on another instance falls back to a replay of the last checkpoint (spec §4).
   - `@b4run/ag-ui/copilotkit-runtime` must be bundled for Node only. The route is already `runtime = "nodejs"`.
   - Confirm that `ALS` survives `createSseEventResponse`'s `observableFactory`; Task 2's route test pins it.
7. **Header spoofing** (finding 9). Covered by `guardedFetch` deleting the headers, plus a test.
8. **Label phrasing** (finding 12). If the server label change is rejected, add `labels={{ fileFlightPlan: { running: … } }}` on `B4Activity`. That rewording also shows in the running step line.
9. **Suggestions only after connect.** `hasSuggestions` waits for `!isConnecting`. W8's suggestion click waits for the pill, so a slow replay delays it but doesn't break it. A failed connect still clears `isConnecting` (`finally`, `:9003`).
10. **The W2 gate.** The replay goes through `thread.events` with the same visitor policy as `/turns`. If the safe journey's thread isn't owned by the web's minted visitor, W2's 200 turns into an empty stream. Check how `/state` passes today (the local policy without a token) and mirror that.

### Critical files for implementation
- /Users/blove/repos/dawn/.claude/worktrees/vibrant-blackburn-42f930/examples/navlog/web/app/components/AppShell.tsx
- /Users/blove/repos/dawn/.claude/worktrees/vibrant-blackburn-42f930/examples/navlog/web/app/api/copilotkit/[...path]/route.ts
- /Users/blove/repos/dawn/.claude/worktrees/vibrant-blackburn-42f930/packages/ag-ui/src/copilotkit/B4Activity.tsx
- /Users/blove/repos/dawn/.claude/worktrees/vibrant-blackburn-42f930/docs/brand/demo/capture.mjs
- /Users/blove/repos/dawn/.claude/worktrees/vibrant-blackburn-42f930/test/harness/workbench-suggestions.ts