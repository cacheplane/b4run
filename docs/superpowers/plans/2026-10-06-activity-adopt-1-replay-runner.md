# Activity adopt, PR 1: replay endpoint and B4 runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CopilotKit chat restores a B4 thread from B4's storage: `GET /threads/:id/events` replays the thread as AG-UI events, and `@b4run/ag-ui/copilotkit-runtime`'s `B4AgentRunner` serves CopilotKit's `connect` from it.

**Architecture:** `turnsFromState` splits into `eventsFromState` (the synthesiser, now emitting a complete, verifier-clean chat replay) and a fold through `reduceTurns`. The runtime serves the events next to `/turns` behind the same gate. The runner extends CopilotKit's `InMemoryAgentRunner` and overrides only `connect`.

**Tech stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), `@ag-ui/core`/`@ag-ui/client` 1.0.1, `@copilotkit/runtime` 1.76.0 (`/v2`), rxjs 7.8.1, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-06-activity-adopt-navlog-design.md` §2.1, §2.2, §4, §5.

## Ground rules for every task

- Run every command from the repo root. Node 24 (`nvm use 24`).
- Build before tests that import `dist/`: `pnpm --filter @b4run/sdk --filter @b4run/ag-ui build` (the CLI tests import `@b4run/ag-ui/view` from dist).
- Biome, scoped: `cd packages/<pkg> && pnpm exec biome check --config-path ../config-biome/biome.json --write <files>`; then `git diff --stat` to confirm only your files changed. Never run a bare `biome check --write` from the root.
- `src/` imports siblings with `.js`; `test/` imports with `.ts` where the package already does so (ag-ui tests import `../../src/view/turns-from-state.js` — follow the file you are next to).
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only the files you changed (other sessions share the stash).
- No retired product name ("Dawn") and no "threadplane"/`tplane` in code or docs. No "byte-identical".

## File map

| File | Change |
|---|---|
| `packages/ag-ui/src/view/turns-from-state.ts` | Export `eventsFromState`; `turnsFromState` folds it. RUN_STARTED carries `input` + `protocolVersion`; every event carries `timestamp`; open subagents close before a run ends (as live does) |
| `packages/ag-ui/src/view/index.ts` | Export `eventsFromState`, `EventsFromStateResult` |
| `packages/ag-ui/test/view/events-from-state.test.ts` | New: replay shape + `verifyEvents` + CopilotKit message list via `connectAgent` |
| `packages/ag-ui/test/view/public-api.test.ts` | Add the new exports |
| `packages/sdk/src/thread-access.ts`, `packages/sdk/test/thread-access.contract.ts` | `thread.events` operation |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | `GET /threads/:id/events` route + `handleApThreadEventsRequest`; `gateThreadRead` accepts `thread.events` |
| `packages/cli/test/thread-events-endpoint.test.ts` | New: gate, 404, 409, drained, parked, resumed, cap |
| `packages/cli/test/thread-events-equivalence.test.ts` | New: live vs replay → same turns and same CopilotKit messages |
| `packages/cli/test/thread-access-coverage.test.ts`, `packages/cli/test/thread-access-endpoints.test.ts` | The new route classified/gated |
| `packages/cli/package.json` | devDependency `@ag-ui/client` `1.0.1` |
| `packages/ag-ui/src/copilotkit-runtime/index.ts`, `.../B4AgentRunner.ts` | New entry |
| `packages/ag-ui/test/copilotkit-runtime/B4AgentRunner.test.ts`, `public-api.test.ts` | New |
| `packages/ag-ui/package.json` | `./copilotkit-runtime` export; optional peers `@copilotkit/runtime`, `rxjs`; devDep `@copilotkit/runtime` |
| `apps/web/app/components/docs/api-reference.ts` (+ `.test.ts`), `scripts/check-docs.mjs`, `packages/cli/test/api-reference-compatibility.test.ts`, `apps/web/content/docs/api.mdx`, `apps/web/content/docs/api/ag-ui.mdx` | Register `./copilotkit-runtime` (node-only) and `eventsFromState` |
| `apps/web/content/docs/dev-server/agent-protocol.mdx`, `thread-access.mdx`, `security-architecture.mdx`, `ag-ui.mdx`, `apps/web/app/llms.txt/route.ts`, `scripts/check-docs.mjs` | Document `/events` and the runner |
| `.changeset/activity-replay-runner.md` | Patch changeset |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated |

---

### Task 1: `eventsFromState` — a complete, verifier-clean replay

**Files:**
- Modify: `packages/ag-ui/src/view/turns-from-state.ts`
- Modify: `packages/ag-ui/src/view/index.ts`
- Create: `packages/ag-ui/test/view/events-from-state.test.ts`
- Modify: `packages/ag-ui/test/view/public-api.test.ts`

Context you need: read `turns-from-state.ts` top to bottom first. Today `turnsFromState` builds `Timed` events (`{ at, event }`) in `synthesiseNamespace`, stable-sorts them by `at`, and folds them through `reduceTurns` with `now = () => at`. The events are almost a chat replay already. Four gaps keep CopilotKit's client (`@ag-ui/client`, which runs `verifyEvents` and `defaultApplyEvents` over a `connect` stream) from using them:

1. `RUN_STARTED` has no `input`, so the user's message never reaches the client's message list. `@ag-ui/client` appends `RUN_STARTED.input.messages` to the agent's messages (that is how CopilotKit's own in-memory runner restores user bubbles).
2. Events have no `timestamp`; the clock lives beside them.
3. A turn that ends (`RUN_FINISHED`/`RUN_ERROR`) with a subagent still open fails the verifier: "Cannot send 'RUN_FINISHED' while subagents are still active". Live, `outbound.ts` `closeOpenSubagents` closes them first: `SUBAGENT_FINISHED { outcome: { type: "suspended", interruptIds? } }` before an interrupt, `SUBAGENT_ERROR { message, code }` otherwise (read `packages/ag-ui/src/outbound.ts:454-512`). The interrupts a suspended child raised carry `subagentRunId: <that child's run id>` in the `RUN_FINISHED` outcome.
4. A subagent's `SUBAGENT_FINISHED` can sort before a child event whose checkpoint is later than the parent's stamped `settledAt` (the verifier rejects events for a finished subagent).

Live `RUN_STARTED` also carries `protocolVersion: PROTOCOL_VERSION` (`outbound.ts:772`); the replay does too.

- [ ] **Step 1: Write the failing tests**

Create `packages/ag-ui/test/view/events-from-state.test.ts`. Reuse the fixture builders in `test/view/turns-from-state.test.ts` (read it; it builds checkpoints with helpers such as human/AI/tool envelopes and stamps). If they are module-local, move the ones you need into `test/view/state-fixtures.ts` and import them from both files — do not copy them.

The tests (write each with concrete fixtures from those helpers):

```ts
import { AbstractAgent, type BaseEvent, type Message, verifyEvents } from "@ag-ui/client"
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { EMPTY, from, lastValueFrom, toArray } from "rxjs"
import { describe, expect, it } from "vitest"
import { eventsFromState, turnsFromState } from "../../src/view/turns-from-state.js"
import { reduceTurns } from "../../src/view/turns.js"

/** An agent whose `connect` replays `events`: the path CopilotKit's chat takes on mount. */
class ReplayAgent extends AbstractAgent {
  constructor(private readonly events: readonly BaseEvent[]) {
    super({ threadId: "t-1" })
  }
  run() {
    return EMPTY
  }
  protected override connect() {
    return from(this.events)
  }
}

async function messagesAfterConnect(events: readonly BaseEvent[]): Promise<Message[]> {
  const agent = new ReplayAgent(events)
  await agent.connectAgent()
  return agent.messages
}

async function verified(events: readonly BaseEvent[]): Promise<BaseEvent[]> {
  return lastValueFrom(from(events).pipe(verifyEvents(), toArray()))
}
```

Cases:

1. **Drained single turn** (user "search" → AI with a `searchCorpus` call → stamped ToolMessage → AI "Found it."):
   - `events[0]` is `RUN_STARTED` with `runId` = the user message id, `protocolVersion: PROTOCOL_VERSION`, and `input` equal to `{ threadId, runId, messages: [{ id: <user id>, role: "user", content: "search" }], tools: [], context: [], state: {}, forwardedProps: {} }`.
   - every event has a numeric `timestamp`, non-decreasing in array order.
   - `await verified(events)` resolves (no throw) and returns the same length.
   - `await messagesAfterConnect(events)` equals, by `role` and content: user "search"; assistant with `toolCalls[0].function.name === "searchCorpus"`; tool message with `toolCallId` of that call; assistant "Found it.". The assistant text message's `id` is the checkpoint AI message's `kwargs.id`.
2. **Two turns, the first failed** (a `b4:turn` stamp with `status: "failed"` on turn 1's head checkpoint): verifier passes (RUN_STARTED after RUN_ERROR is allowed) and the connected messages hold both user messages.
3. **Parked head with an open subagent** (a `task` call without a ToolMessage whose child namespace is parked; pending interrupt whose `value` names that child — use the existing parked-subagent fixture in `turns-from-state.test.ts`): the event before the final `RUN_FINISHED` is `SUBAGENT_FINISHED { subagentRunId: <task call id>, outcome: { type: "suspended", interruptIds: [<id>] } }`; the final `RUN_FINISHED.outcome.interrupts[0].subagentRunId` is the task call id; `verified(events)` resolves.
4. **A stopped turn with an open subagent** (stamp `status: "stopped"`, task call without a ToolMessage, not the head — follow it with a second user turn): a `SUBAGENT_ERROR { subagentRunId, message: "The run was cancelled.", code: "cancelled" }` precedes that turn's `RUN_FINISHED { outcome: { type: "cancelled" } }`; verifier passes. With `status: "completed"` instead the code is `"unterminated"` and the message "The run ended before the subagent finished." (mirror `outbound.ts`'s `reason.kind` strings exactly: read the `SubagentCloseReason` type there and reuse its spelling).
5. **Child checkpoint later than the parent's stamp**: a finished `task` whose `b4_step.settledAt` is earlier than the child namespace's last checkpoint `ts`: `SUBAGENT_FINISHED` comes after every event carrying that `subagentRunId`; verifier passes.
6. **`turnsFromState` is the fold**: for every fixture above, `turnsFromState(state).turns` deep-equals folding `eventsFromState(state).events` with `reduceTurns(view, e, { now: () => e.timestamp ?? 0, resuming: false })` starting from `{ threadId, turns: [] }`.

- [ ] **Step 2: Run them; they fail**

Run: `pnpm --filter @b4run/ag-ui exec vitest --run test/view/events-from-state.test.ts`
Expected: FAIL (`eventsFromState` is not exported).

- [ ] **Step 3: Implement**

In `turns-from-state.ts`:

```ts
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"

export interface EventsFromStateResult {
  /** The thread as the AG-UI stream its live runs would have carried, in order, each with `timestamp`. */
  readonly events: readonly BaseEvent[]
  /** The same lines `turnsFromState` reports. */
  readonly warnings: readonly string[]
}
```

- Add to `Synth`: `readonly open: string[]` — subagent run ids (task call ids) started and not yet finished, in start order.
- `openSubagent`: after the `SUBAGENT_STARTED` push, `s.open.push(toolCallId)`. Record `const before = s.events.length` before synthesising the child; after it, `childLatest = max(at)` over `s.events.slice(before)` (0 when none) and return it.
- In the `ToolMessage` subagent branch: `const finishAt = Math.max(settledAt, childLatest)`; use `finishAt` for `SUBAGENT_ERROR`/`SUBAGENT_FINISHED`; after pushing either, remove the id from `s.open`. Keep `settledAt` for nothing else in that branch.
- A helper that closes every open subagent, newest first, mirroring `closeOpenSubagents`:

```ts
/** Close the subagents still open when a root turn ends, as `outbound.ts` does live. */
function closeOpen(
  s: Synth,
  at: number,
  reason:
    | { readonly kind: "interrupt"; readonly interrupts: readonly { id: string; subagentRunId?: string; toolCallId?: string }[] }
    | { readonly kind: "cancelled" | "unterminated" },
): ReadonlySet<string> {
  const closed = new Set<string>()
  for (const id of [...s.open].reverse()) {
    closed.add(id)
    if (reason.kind === "interrupt") {
      const interruptIds = reason.interrupts
        .filter((i) => (i.subagentRunId ?? i.toolCallId) === id)
        .map((i) => i.id)
      push(s, at, {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: id,
        outcome: { type: "suspended", ...(interruptIds.length > 0 ? { interruptIds } : {}) },
      } as BaseEvent)
    } else {
      push(s, at, {
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: id,
        message: reason.kind === "cancelled" ? "The run was cancelled." : "The run ended before the subagent finished.",
        code: reason.kind,
      } as BaseEvent)
    }
  }
  s.open.length = 0
  return closed
}
```

  These are `outbound.ts`'s `SubagentCloseReason` kinds and messages verbatim.
- `closeRun` (root only — it already returns early when `nested`): before each terminal push call `closeOpen` at the same `at` as that terminal event (push order keeps it first under the stable sort):
  - parked: `const suspended = closeOpen(s, lastAt, { kind: "interrupt", interrupts })`, then map interrupts: `suspended.has(run) && interrupt.subagentRunId === undefined ? { ...interrupt, subagentRunId: run } : interrupt` where `run = interrupt.subagentRunId ?? interrupt.toolCallId` (exactly `finishInterrupted`).
  - failed (`RUN_ERROR`): `closeOpen(s, endAt, { kind: "unterminated" })`.
  - stopped (`cancelled`): `closeOpen(s, endAt, { kind: "cancelled" })`.
  - success: `closeOpen(s, endAt, { kind: "unterminated" })`.
  - busy head left open: do not close.
- `RUN_STARTED` push (root `HumanMessage` branch):

```ts
push(s, at, {
  type: EventType.RUN_STARTED,
  threadId: input.threadId,
  runId: id,
  protocolVersion: PROTOCOL_VERSION,
  input: {
    threadId: input.threadId,
    runId: id,
    messages: [{ id, role: "user", content: textOf(kwargs.content) }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  },
} as BaseEvent)
```

- Split the export. Move everything in today's `turnsFromState` up to and including the sort into `eventsFromState`, which returns `{ events: ordered.map(({ at, event }) => ({ ...event, timestamp: at })), warnings }`. Then:

```ts
export function turnsFromState(input: ThreadStateForTurns): TurnsFromStateResult {
  const { events, warnings } = eventsFromState(input)
  if (events.length === 0 && !isRecord(input)) return { turns: EMPTY_TURNS, warnings }
  const threadId = isRecord(input) && typeof input.threadId === "string" ? input.threadId : ""
  let view: TurnsView = { threadId, turns: [] }
  const issues = [...warnings]
  try {
    for (const event of events) {
      const at = event.timestamp ?? 0
      view = reduceTurns(view, event, { now: () => at, resuming: false })
    }
  } catch (error) {
    issues.push(`reduction stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { turns: view, warnings: issues }
}
```

  Keep today's behaviour exactly where `normalise` returns `undefined` (`EMPTY_TURNS` + warnings): have `eventsFromState` return `{ events: [], warnings }` in that case and make `turnsFromState` return `EMPTY_TURNS` when `normalise` would have — simplest is a module-private `synthesise(input)` returning `{ normalised, events, warnings }` used by both exports.
- Update both functions' doc comments (`eventsFromState`: "the AG-UI events a live client would have received for this thread, synthesised from its checkpoints — a CopilotKit `connect` replay; never throws").
- `view/index.ts`: add `eventsFromState` and `type EventsFromStateResult` to the `turns-from-state.js` export block.
- `test/view/public-api.test.ts`: add `eventsFromState` to the expected runtime export list.

- [ ] **Step 4: Run the ag-ui suite**

Run: `pnpm --filter @b4run/ag-ui exec vitest --run test/view`
Expected: PASS. If an existing `turns-from-state.test.ts` case about a parked or stopped subagent now differs, it is because the subagent now closes as it does live: change the expectation only when the new value is what the live reducer produces for the same run (a suspended child shows `outcome: "suspended"`-style state per `reduceTurns`), and say so in the commit message.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @b4run/ag-ui typecheck
pnpm --filter @b4run/ag-ui lint
git add packages/ag-ui/src/view packages/ag-ui/test/view
git commit -m "feat(ag-ui): eventsFromState replays a thread as the AG-UI stream a client would have received"
```

---

### Task 2: the `thread.events` operation

**Files:** `packages/sdk/src/thread-access.ts`, `packages/sdk/test/thread-access.contract.ts`

- [ ] **Step 1:** In `thread-access.ts`, next to `thread.turns` (doc list near line 28 and the union near line 72), add `thread.events` — doc line `` * - `thread.events` — `GET /threads/:id/events` — `read` ``; union member `| "thread.events"`. In `thread-access.contract.ts` add `| "thread.events"` beside `"thread.turns"`.
- [ ] **Step 2:** `pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk test && pnpm --filter @b4run/sdk build`. Expected: PASS.
- [ ] **Step 3:** Commit `feat(sdk): thread.events read operation`.

---

### Task 3: `GET /threads/:thread_id/events`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Create: `packages/cli/test/thread-events-endpoint.test.ts`
- Modify: `packages/cli/test/thread-access-coverage.test.ts`, `packages/cli/test/thread-access-endpoints.test.ts`

Read first: `runtime-fetch-core.ts` lines ~2195-2230 (the `/turns` route), ~3570-3600 (`gateThreadRead`), ~3830-3855 (`handleApThreadTurnsRequest`). Run `git log --format=%h -S"handleApThreadTurnsRequest" -- packages/cli/src/lib/dev/runtime-fetch-core.ts | tail -1` and `git show <that sha> -- packages/cli/test/thread-access-coverage.test.ts packages/cli/test/thread-access-endpoints.test.ts` to see exactly how `/turns` was added to the coverage tests, and mirror it.

- [ ] **Step 1: Write the failing endpoint test**

Copy `packages/cli/test/thread-turns-endpoint.test.ts` to `thread-events-endpoint.test.ts` and convert it. Keep the fixture app, `withAimock`, `createHandler`, the request builders and readers; replace `turnsRequest` with `eventsRequest` (`/threads/${threadId}/events`) and the body type with:

```ts
interface EventsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly events: readonly BaseEvent[]
  readonly warnings: readonly string[]
  readonly truncated: boolean
}
```

Cases (same names, `/events`):
- 404 for an unknown thread, same bytes under a denying policy.
- deny of an existing thread → same 404 bytes as a miss.
- uses `thread.events` as a `read` and the route's middleware; a graph route's thread → `{ status: "idle", threadId, truncated: false, events: [], warnings: [] }`.
- runs the route's middleware with a GET (403 then 200).
- 409 `thread_route_unknown` for a thread that never ran.
- drained `/search#agent` run: `events[0]` is `RUN_STARTED` whose `input.messages[0]` is `{ role: "user", content: "search" }` (match with `toMatchObject`), the last event is `RUN_FINISHED` with `outcome.type === "success"`, there is a `TOOL_CALL_START` with `toolCallName: "searchCorpus"`, a `TOOL_CALL_RESULT`, and a `TEXT_MESSAGE_CONTENT` with delta `"Found it."`; `warnings` is `[]`; `cache-control: no-store`.
- parked `/park#agent` run: last event is `RUN_FINISHED` with `outcome.type === "interrupt"` and `outcome.interrupts[0].id` equal to `/pending_interrupts`' `interruptId`; after resume, the last event is `RUN_FINISHED` success and there is exactly one `RUN_STARTED`.
- cap: the 2001-checkpoint fixture → `truncated: true` and the last `RUN_STARTED.runId` is the newest user message id.

- [ ] **Step 2: Run it; it fails**

Run: `pnpm --filter @b4run/sdk --filter @b4run/ag-ui build && pnpm --filter @b4run/cli exec vitest --run test/thread-events-endpoint.test.ts`
Expected: FAIL (404s from an unmatched route).

- [ ] **Step 3: Implement**

- `import { eventsFromState, turnsFromState } from "@b4run/ag-ui/view"`.
- `gateThreadRead`'s `operation` type: `Extract<ThreadOperation, "thread.pending_interrupts" | "thread.turns" | "thread.events">`; extend its doc comment ("Shared by `GET /pending_interrupts`, `GET /turns` and `GET /events`…").
- Route, directly after the `/turns` route:

```ts
    // ------------------------------------------------------------------
    // GET /threads/:thread_id/events — the thread replayed as AG-UI events, from storage
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleApThreadEventsRequest({
          checkpointer: getCheckpointer(request),
          middleware,
          registry,
          request,
          threadAccess,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/events(?:\?.*)?$/,
    },
```

- Handler, after `handleApThreadTurnsRequest`:

```ts
/**
 * `GET /threads/:id/events`: the same gates as `/turns` under `thread.events`,
 * then the thread replayed as the AG-UI events its live runs would have
 * carried (`eventsFromState`): a chat client's `connect` restores its
 * messages, activity and any parked approval from it. A busy thread gets the
 * last written checkpoint and never waits on the run.
 */
async function handleApThreadEventsRequest(options: ThreadReadOptions): Promise<Response> {
  const gated = await gateThreadRead(options, "thread.events")
  if (!gated.ok) return gated.response
  const { checkpointer, threadId } = options
  const status = gated.thread.status
  const { state, truncated } = await loadThreadStateForTurns(checkpointer, threadId, status)
  const { events, warnings } = eventsFromState(state)
  return Response.json(
    { threadId, status, events, warnings, truncated },
    { headers: { "cache-control": "no-store" }, status: 200 },
  )
}
```

- Coverage tests: add the `/events` route key and classification exactly where `/turns` sits, and bump the route count comment/number the way the `/turns` commit did.

- [ ] **Step 4: Run**

Run: `pnpm --filter @b4run/cli exec vitest --run test/thread-events-endpoint.test.ts test/thread-turns-endpoint.test.ts test/thread-access-coverage.test.ts test/thread-access-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(cli): GET /threads/:id/events replays a thread from storage as AG-UI events`.

---

### Task 4: live vs replay equivalence

**Files:** Create `packages/cli/test/thread-events-equivalence.test.ts`; modify `packages/cli/package.json` (devDependency `"@ag-ui/client": "1.0.1"`, alphabetical), `pnpm-lock.yaml` (via `pnpm install`).

- [ ] **Step 1:** `pnpm install` after adding the devDependency; `git diff --stat pnpm-lock.yaml` must show only the `packages/cli` importer block changing (if other importers re-key, stop and report).
- [ ] **Step 2: Write the test.** Base it on `thread-turns-equivalence.test.ts` (same fixture app, `aguiRun`, `parseSseEvents`, `fold`, `normaliseValue`). Add the `ReplayAgent`/`messagesAfterConnect` helper from Task 1 and a live counterpart: a second `ReplayAgent` over the live SSE events (the live stream's `RUN_STARTED` has no `input`, so seed the live agent with the user message first: `new ReplayAgent(events)` then `agent.messages = [{ id: "u", role: "user", content }]` before `connectAgent()`; `agent.setMessages([...])` is the 1.0.1 API).

Message normalisation: replace every `id` and `toolCallId`/`toolCalls[].id` with its first-seen ordinal (`m0`, `m1`… and `c0`, `c1`…), drop `subagentRunId`-tagged messages (the chat never shows them; the connector filters with `isSubagentMessage`), and compare `role`, `content`, `toolCalls[].function.{name,arguments}`, `toolCallId`.

Cases:
1. Drained `/search#agent`: replay messages equal live messages after normalisation; `fold(events)` normalised equals the `/turns` body's `turns` normalised (the existing `normaliseValue`).
2. Parked `/park#agent`: both message lists end with an assistant message carrying the `deployProd` call and no tool result; the replay agent's `pendingInterrupts` (set by `RUN_FINISHED { interrupt }`, see `@ag-ui/client`) holds one interrupt whose `id` equals the live one's. After resume, replay (one run) and live (park + resume runs folded into one agent, connect the live park events then the resume events) end with the same normalised messages.

- [ ] **Step 3:** `pnpm --filter @b4run/cli exec vitest --run test/thread-events-equivalence.test.ts` → PASS. Lint + typecheck the cli package (`pnpm --filter @b4run/cli lint && pnpm --filter @b4run/cli typecheck`).
- [ ] **Step 4:** Commit `test(cli): a replayed thread restores the same chat messages and turns as its live run`.

---

### Task 5: `B4AgentRunner` in `@b4run/ag-ui/copilotkit-runtime`

**Files:**
- Create: `packages/ag-ui/src/copilotkit-runtime/B4AgentRunner.ts`, `packages/ag-ui/src/copilotkit-runtime/index.ts`
- Create: `packages/ag-ui/test/copilotkit-runtime/B4AgentRunner.test.ts`, `packages/ag-ui/test/copilotkit-runtime/public-api.test.ts`
- Modify: `packages/ag-ui/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Package wiring.** In `packages/ag-ui/package.json`:
  - `exports`: after `./copilotkit`, add `"./copilotkit-runtime": { "types": "./dist/copilotkit-runtime/index.d.ts", "default": "./dist/copilotkit-runtime/index.js" }`.
  - `peerDependencies`: `"@copilotkit/runtime": ">=1.76.0"`, `"rxjs": ">=7.8.0 <8.0.0"`; both `optional: true` in `peerDependenciesMeta`.
  - `devDependencies`: `"@copilotkit/runtime": "1.76.0"` (rxjs 7.8.1 is already there).
  - `pnpm install`; `git diff --stat pnpm-lock.yaml` must show only the `packages/ag-ui` importer (plus any new package entries `@copilotkit/runtime@1.76.0` already resolves for the examples — it should reuse the existing resolution). If examples' importers re-key, stop and report.

- [ ] **Step 2: Write the failing tests** (`B4AgentRunner.test.ts`):

```ts
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { lastValueFrom, of, toArray } from "rxjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { B4AgentRunner } from "../../src/copilotkit-runtime/index.js"

const EVENTS: BaseEvent[] = [
  { type: EventType.RUN_STARTED, threadId: "t-1", runId: "u-1" } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: "t-1", runId: "u-1", outcome: { type: "success" } } as BaseEvent,
]

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  )
}

afterEach(() => vi.restoreAllMocks())

describe("B4AgentRunner.connect", () => {
  it("replays /threads/:id/events from the B4 server when no run is live here", async () => {
    const fetch = jsonFetch(200, { threadId: "t-1", status: "idle", events: EVENTS, warnings: [], truncated: false })
    const runner = new B4AgentRunner({ url: "http://b4.test/", fetch })
    const events = await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))
    expect(events).toEqual(EVENTS)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://b4.test/threads/t-1/events")
  })

  it("encodes the thread id in the path", async () => {
    const fetch = jsonFetch(200, { threadId: "a/b", status: "idle", events: [], warnings: [], truncated: false })
    await lastValueFrom(new B4AgentRunner({ url: "http://b4.test", fetch }).connect({ threadId: "a/b" }).pipe(toArray()))
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://b4.test/threads/a%2Fb/events")
  })

  it("forwards the connect request's headers", async () => {
    const fetch = jsonFetch(200, { threadId: "t-1", status: "idle", events: [], warnings: [], truncated: false })
    await lastValueFrom(
      new B4AgentRunner({ url: "http://b4.test", fetch })
        .connect({ threadId: "t-1", headers: { authorization: "Bearer x" } })
        .pipe(toArray()),
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer x")
  })

  it.each([404, 409])("completes empty on %i (nothing to restore)", async (status) => {
    const runner = new B4AgentRunner({ url: "http://b4.test", fetch: jsonFetch(status, { error: {} }) })
    expect(await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))).toEqual([])
  })

  it("errors with the status on any other failure", async () => {
    const runner = new B4AgentRunner({ url: "http://b4.test", fetch: jsonFetch(503, { error: {} }) })
    await expect(lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))).rejects.toThrow(/503/)
  })

  it("delegates to the in-memory runner while a run for the thread is live in this process", async () => {
    const fetch = jsonFetch(200, {})
    const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
    vi.spyOn(runner, "isRunning").mockResolvedValue(true)
    const live = vi.spyOn(InMemoryAgentRunner.prototype, "connect").mockReturnValue(of(...EVENTS))
    const events = await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))
    expect(events).toEqual(EVENTS)
    expect(live).toHaveBeenCalledWith({ threadId: "t-1" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reports replay warnings once through onWarnings", async () => {
    const onWarnings = vi.fn()
    const fetch = jsonFetch(200, { threadId: "t-1", status: "idle", events: [], warnings: ["w"], truncated: false })
    await lastValueFrom(new B4AgentRunner({ url: "http://b4.test", fetch, onWarnings }).connect({ threadId: "t-1" }).pipe(toArray()))
    expect(onWarnings).toHaveBeenCalledWith("t-1", ["w"])
  })

  it("aborts the replay read when the subscriber unsubscribes", async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const subscription = new B4AgentRunner({ url: "http://b4.test", fetch }).connect({ threadId: "t-1" }).subscribe()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    subscription.unsubscribe()
    expect(signal?.aborted).toBe(true)
  })
})
```

`public-api.test.ts`: `expect(Object.keys(await import("../../src/copilotkit-runtime/index.js")).sort()).toEqual(["B4AgentRunner"])` (match the style of `test/copilotkit/public-api.test.ts`).

- [ ] **Step 3: Run; they fail** — `pnpm --filter @b4run/ag-ui exec vitest --run test/copilotkit-runtime` → FAIL (module not found).

- [ ] **Step 4: Implement** `B4AgentRunner.ts`:

```ts
import type { BaseEvent } from "@ag-ui/core"
import { type AgentRunnerConnectRequest, InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { Observable } from "rxjs"

export interface B4AgentRunnerOptions {
  /** The B4 server's base URL: the origin `B4HttpAgent` posts `/agui/...` to. */
  readonly url: string
  /** Fetch for the replay read; pass the same one your `B4HttpAgent` uses to add auth headers. */
  readonly fetch?: typeof fetch
  /** Called once per replay that carried warnings (stamps the server could not read). Defaults to `console.warn`. */
  readonly onWarnings?: (threadId: string, warnings: readonly string[]) => void
}

interface EventsBody {
  readonly events?: readonly BaseEvent[]
  readonly warnings?: readonly string[]
}

/**
 * CopilotKit's in-memory runner with `connect` served from B4's storage. Runs
 * are the in-memory runner's (a run forwards to the route's agent and keeps
 * the live tail in this process); `connect` rejoins that tail while the run is
 * live here, and otherwise replays `GET /threads/:id/events`, so a reload, a
 * restart or another instance restores the chat, its activity and any parked
 * approval from the checkpoint.
 */
export class B4AgentRunner extends InMemoryAgentRunner {
  readonly #url: string
  readonly #fetch: typeof fetch
  readonly #onWarnings: (threadId: string, warnings: readonly string[]) => void

  constructor(options: B4AgentRunnerOptions) {
    super()
    this.#url = options.url.replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onWarnings =
      options.onWarnings ??
      ((threadId, warnings) =>
        console.warn(`B4 replay of thread ${threadId}: ${warnings.join("; ")}`))
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController()
      let live: { unsubscribe(): void } | undefined
      const replay = async (): Promise<void> => {
        if (await this.isRunning({ threadId: request.threadId })) {
          live = super.connect(request).subscribe(subscriber)
          return
        }
        const response = await this.#fetch(
          `${this.#url}/threads/${encodeURIComponent(request.threadId)}/events`,
          { headers: { ...request.headers, accept: "application/json" }, signal: controller.signal },
        )
        // 404: no such thread (or not this caller's). 409: created but never ran. Nothing to restore.
        if (response.status === 404 || response.status === 409) {
          subscriber.complete()
          return
        }
        if (!response.ok) {
          throw new Error(`B4 replay of thread ${request.threadId} failed with ${response.status}`)
        }
        const body = (await response.json()) as EventsBody
        if (body.warnings !== undefined && body.warnings.length > 0) {
          this.#onWarnings(request.threadId, body.warnings)
        }
        for (const event of body.events ?? []) subscriber.next(event)
        subscriber.complete()
      }
      replay().catch((error: unknown) => {
        if (!controller.signal.aborted) subscriber.error(error)
      })
      return () => {
        controller.abort()
        live?.unsubscribe()
      }
    })
  }
}
```

  If TypeScript rejects `super.connect` inside the nested async function, hoist `const connectLive = (r: AgentRunnerConnectRequest) => super.connect(r)` at the top of `connect` and call that. Check `AgentRunnerConnectRequest.headers`'s type in `@copilotkit/runtime/dist/v2/runtime/runner/agent-runner.d.mts`; spread it only when it is a plain record (it is `Record<string, string> | undefined` in 1.76).

  `index.ts`:

```ts
/**
 * `@b4run/ag-ui/copilotkit-runtime` — the server half of the CopilotKit
 * connector: a CopilotKit runtime runner whose `connect` restores a thread
 * from B4's storage. `@copilotkit/runtime` (>=1.76, the v2 API) and `rxjs`
 * are optional peer dependencies of `@b4run/ag-ui`; this is the only entry
 * that imports them. Node only.
 */
export { B4AgentRunner, type B4AgentRunnerOptions } from "./B4AgentRunner.js"
```

- [ ] **Step 5: Run** `pnpm --filter @b4run/ag-ui exec vitest --run test/copilotkit-runtime` → PASS; `pnpm --filter @b4run/ag-ui build && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint` → PASS; `node --input-type=module -e "await import('@b4run/ag-ui/copilotkit-runtime')"` run from `packages/cli` (which depends on `@b4run/ag-ui`)… the cli does not depend on `@copilotkit/runtime`, so instead run from `examples/navlog/web`: `cd examples/navlog/web && node --input-type=module -e "const m = await import('@b4run/ag-ui/copilotkit-runtime'); console.log(Object.keys(m))"` → `[ 'B4AgentRunner' ]`.

- [ ] **Step 6: Commit** `feat(ag-ui): @b4run/ag-ui/copilotkit-runtime — B4AgentRunner restores CopilotKit's connect from B4 storage`.

---

### Task 6: register the entry and document `/events` and the runner

Mirror how #926 registered `./copilotkit` (`git show 2cbca78ba -- scripts/check-docs.mjs apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts packages/cli/test/api-reference-compatibility.test.ts apps/web/content/docs/api.mdx`) and how #954 documented `/turns` (`git show $(git log --format=%h -S"handleApThreadTurnsRequest" -- packages/cli/src/lib/dev/runtime-fetch-core.ts | tail -1) -- apps scripts`).

- [ ] **Step 1: Registry.**
  - `apps/web/app/components/docs/api-reference.ts`: `runtimeImport("@b4run/ag-ui", "./copilotkit-runtime", "detailed", "node-only", "application")` after the `./copilotkit` line; `importAddress("@b4run/ag-ui", "./copilotkit-runtime")` in `PACKAGE_CATALOG` after `./copilotkit`.
  - `apps/web/app/components/docs/api-reference.test.ts`: `["@b4run/ag-ui", "./copilotkit-runtime"]` in `EXPECTED_DETAILED_IMPORTS`; import count `48` → `49`.
  - `scripts/check-docs.mjs`: `["import:@b4run/ag-ui:./copilotkit-runtime", "detailed", "surfaceKind", "typescript-runtime"]` in `EXPECTED_API_ARTIFACT_POLICY_TUPLES` after `./copilotkit`. It is not edge-safe and not browser-only (no set changes).
  - `packages/cli/test/api-reference-compatibility.test.ts`: if it enumerates ag-ui entries (see line ~1521), add `./copilotkit-runtime` with `runtime: "node-only"`. Run it: `pnpm --filter @b4run/cli exec vitest --run test/api-reference-compatibility.test.ts`. The node-only guards bundle the entry for Node (must succeed) and for a browser (must fail — `@copilotkit/runtime` pulls Node built-ins). If the browser negative control unexpectedly succeeds or the Node bundle fails, stop and report the exact output.
  - `apps/web/content/docs/api.mdx`: in the `@b4run/ag-ui` row add `` `@b4run/ag-ui/copilotkit-runtime` `` after `` `@b4run/ag-ui/copilotkit` `` in Surfaces and `focused reference · \`node-only\` runtime · \`not-claimed\` purity` at the same position in Artifact boundaries.
- [ ] **Step 2: `/docs/api/ag-ui`.** In `### \`@b4run/ag-ui/view\`` add after the `turnsFromState` row:
  `| \`eventsFromState\` | The thread as the AG-UI events its live runs would have carried, synthesised from the same input as \`turnsFromState\`: each turn's \`RUN_STARTED\` carries the user message, a parked turn ends with \`RUN_FINISHED { outcome: interrupt }\`. What \`GET /threads/:id/events\` serves. Never throws. |`
  `| \`EventsFromStateResult\` | What \`eventsFromState\` returns: \`events\` (each with \`timestamp\`) and \`warnings\`. |`
  After the `./copilotkit` section, a new section:

  ```mdx
  ### `@b4run/ag-ui/copilotkit-runtime`

  The server half of the CopilotKit connector, for the CopilotKit runtime route in your app (Node only).

  | Export | Responsibility |
  |---|---|
  | `B4AgentRunner` | A CopilotKit runtime runner (`new CopilotRuntime({ agents, runner })`): runs are CopilotKit's in-memory runner's; `connect` rejoins a run live in this process, and otherwise replays `GET /threads/:id/events` from the B4 server, so a reload or a new instance restores the chat, its activity and a parked approval. |
  | `B4AgentRunnerOptions` | The B4 server's `url`, the `fetch` to read with (pass the one your `B4HttpAgent` uses), and `onWarnings` for replays that carried warnings. |
  ```

  Add `@copilotkit/runtime` and `rxjs` to the install/peer text in "## Install and import" where `@copilotkit/react-core` is described.
- [ ] **Step 3: Agent Protocol.** `apps/web/content/docs/dev-server/agent-protocol.mdx`: a table row after `/turns`:
  `| \`GET /threads/:thread_id/events\` | None | \`200 { threadId, status, events, warnings, truncated }\`: the thread replayed as the AG-UI events its live runs would have carried (\`@b4run/ag-ui/view\`'s \`eventsFromState\`). \`404\` \`thread_not_found\`. \`409\` \`thread_route_unknown\` when no route is recorded |`
  and one paragraph at the end of "### Restoring a thread's activity": "`GET /threads/:thread_id/events` serves the same restore as AG-UI events instead of a view: each turn's `RUN_STARTED` carries its user message, and a parked turn ends with `RUN_FINISHED` carrying the interrupt. A chat client that restores by replaying events, such as CopilotKit through `B4AgentRunner`, reads this one. It shares `/turns`' gate, cap and warnings."
- [ ] **Step 4: Gate docs.** Everywhere `thread-access.mdx` and `security-architecture.mdx` list `GET /threads/:thread_id/turns` (lines 149, 236, 250, 253 and the security table row 37), add `GET /threads/:thread_id/events` beside it with the same behaviour (404 same bytes; composes with middleware; gate before middleware).
- [ ] **Step 5: AG-UI guide.** `apps/web/content/docs/ag-ui.mdx`, in the CopilotKit part of "Consuming it from a web UI", a short subsection "Restoring a conversation after a reload":

  ```mdx
  CopilotKit's chat calls `connect` when it mounts. Its default in-memory runner only remembers runs this process served, so give the runtime `B4AgentRunner` and the chat restores from B4's checkpoints instead:

  ```ts
  import { B4HttpAgent } from "@b4run/ag-ui/client"
  import { B4AgentRunner } from "@b4run/ag-ui/copilotkit-runtime"
  import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"

  const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3000"
  const agent = new B4HttpAgent({ url: `${b4Url}/agui/${encodeURIComponent("/chat#agent")}` })
  const runtime = new CopilotRuntime({ agents: { default: agent }, runner: new B4AgentRunner({ url: b4Url }) })
  export const POST = createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" })
  ```

  The runner reads `GET /threads/:thread_id/events`, so the thread-access policy and route middleware that guard the run guard the restore too.
  ```

  Check the existing guide's port and route-id conventions (`%2Fchat%23agent` is pinned by check-docs) and match them.
- [ ] **Step 6: llms.txt and check-docs.** `apps/web/app/llms.txt/route.ts`: `"- \`GET /threads/:thread_id/events\`",` after the `/turns` line. `scripts/check-docs.mjs`: add `"GET /threads/:thread_id/events"` after `"GET /threads/:thread_id/turns"` in both required lists (~2806 and ~5044).
- [ ] **Step 7: Changeset** `.changeset/activity-replay-runner.md`:

  ```md
  ---
  "@b4run/ag-ui": patch
  "@b4run/cli": patch
  "@b4run/sdk": patch
  ---

  Restore a CopilotKit chat from B4's storage. `GET /threads/:thread_id/events` replays a thread as the AG-UI events its live runs carried (`eventsFromState` in `@b4run/ag-ui/view`), behind the same gate as `/turns` (new `thread.events` operation). `@b4run/ag-ui/copilotkit-runtime` adds `B4AgentRunner`, a CopilotKit runtime runner whose `connect` replays it, so a reload, a restart or another instance restores the chat, its activity and a parked approval.
  ```
- [ ] **Step 8: Verify docs and SEO.** Commit the docs first, then `pnpm --dir apps/web seo:lastmod` and commit `apps/web/app/seo/lastmod.generated.json`. Run `node scripts/check-docs.mjs`, `pnpm --filter @b4run/web test -- app/components/docs/api-reference.test.ts` (or the package's vitest invocation for that file), `pnpm --dir apps/web seo:lastmod:routes`. All PASS.
- [ ] **Step 9: Commit** `docs: GET /threads/:id/events and @b4run/ag-ui/copilotkit-runtime` (+ a separate `chore(web): regenerate seo lastmod`).

---

### Task 7: full gate and PR

- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` from the root (Node 24). Investigate any failure; `vercel-target.test.ts`/`dev-command.test.ts` timeouts under load pass when rerun alone — rerun those alone before calling them flakes.
- [ ] `pnpm check:release-inventory && node scripts/check-docs.mjs && pnpm pack:check`.
- [ ] Push and open the PR "feat: restore a CopilotKit chat from B4 storage (activity adopt, PR 1/3)" with a body summarising the endpoint, the runner, the replay's verifier fixes, and the test plan; end with the Claude Code line.
