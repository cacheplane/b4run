// A thread restored through `GET /threads/:id/turns` equals the view a live
// AG-UI client builds from the same run with `reduceTurns`. Both sides go
// through the real runtime: the live side POSTs `RunAgentInput` to the AG-UI
// endpoint and folds the SSE events; the restored side reads the checkpoints.
//
// Deliberate, documented differences the comparison normalises away:
//
// - `runId`: live carries the transport run id the client sent in
//   `RunAgentInput.runId` (and a resumed turn takes the resuming run's id);
//   restored uses the turn's user message id, since the checkpoint never saw a
//   transport run id (spec §3, `turns-from-state.ts`). Both become `"turn"`.
// - Clocks (`startedAt`, `settledAt`, `endedAt`, `updatedAt`): live reads the
//   client's clock when each event arrives; restored reads the stamped
//   `b4_step` times and checkpoint timestamps. Both become `0`.
// - Reasoning step `id`/`messageId`: live uses the stream's span/message ids;
//   restored derives `rspan:<message id>`/`rsn:<message id>`. Both become `"r"`.
// - `approval.grant`: the app runs with the default `approvals.grants: "off"`,
//   so neither side carries one; the comparison strips it anyway so the test
//   stays about shape, not grant policy (grants are pinned in
//   `thread-turns-endpoint.test.ts`).
//
// An AWAITING step is NOT normalised: live shows the `running` label and icon
// the runtime streamed as `b4.step` before the gate parked the call, and the
// gate keeps that display on the checkpointed interrupt (`step`), so the
// restored awaiting step carries the same label and icon.
//
// Everything else — statuses, names, args, results, labels, icons, sources,
// text, the approval's `interruptId`/`kind`/`detail`/`message`/`offersAlways`,
// `failed`, `approvals`, `threadId` — must be deep-equal.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { BaseEvent } from "@ag-ui/core"
import { reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture app: the routes thread-turns-endpoint.test.ts uses
// ---------------------------------------------------------------------------

/** Agent route whose `deployProd` tool requires human approval, so the first
 * call to it parks the turn on a real checkpointer-backed HITL interrupt. */
const PARK_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

/** Agent route with one ungated tool: a run through it drains without parking. */
const SEARCH_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  "})",
  "",
].join("\n")

/** Both tools declare a `display`, so labels, icons and sources are part of
 * the comparison: live sees a running label and then the done one; restored
 * sees only the stamped done label, and both must land on the same step. */
const DEPLOY_TOOL = [
  'import type { ToolDisplay } from "@b4run/sdk"',
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  return 'deployed to ' + input.env",
  "}",
  "export const display: ToolDisplay<{ env: string }, string> = {",
  '  icon: "run",',
  "  running: (input) => 'Deploying to ' + input.env + '…',",
  "  done: (input) => 'Deployed to ' + input.env,",
  "}",
  "",
].join("\n")

const SEARCH_TOOL = [
  'import type { ToolDisplay } from "@b4run/sdk"',
  "/** Search the corpus. */",
  "export default async function searchCorpus(input: { query: string }): Promise<string> {",
  "  return '3 hits'",
  "}",
  "export const display: ToolDisplay<{ query: string }, string> = {",
  '  icon: "search",',
  "  running: (input) => 'Searching the corpus for ' + input.query + '…',",
  "  done: (input, output) => 'Searched the corpus for ' + input.query + ': ' + output,",
  '  sources: () => [{ title: "Corpus", href: "https://example.test/corpus" }],',
  "}",
  "",
].join("\n")

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-thread-turns-eq-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-turns-equivalence-fixture", "type": "module" }\n',
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
    "src/app/search/index.ts": SEARCH_ROUTE,
    "src/app/search/tools/searchCorpus.ts": SEARCH_TOOL,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
 * restoring the previous env afterward. Call BEFORE creating the handler. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

async function createHandler(appRoot: string) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

// ---------------------------------------------------------------------------
// The live side: POST RunAgentInput to /agui/<route>, fold the SSE events
// ---------------------------------------------------------------------------

interface AguiRunOptions {
  readonly threadId: string
  readonly runId: string
  readonly route: string
  readonly message: string
  readonly resume?: readonly unknown[]
}

function parseSseEvents(text: string): BaseEvent[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length)
    return data ? [JSON.parse(data) as BaseEvent] : []
  })
}

async function aguiRun(handler: Handler, options: AguiRunOptions): Promise<BaseEvent[]> {
  const response = await handler.fetch(
    new Request(`http://localhost/agui/${encodeURIComponent(options.route)}`, {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ content: options.message, id: `u-${options.runId}`, role: "user" }],
        runId: options.runId,
        state: {},
        threadId: options.threadId,
        tools: [],
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
      }),
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      method: "POST",
    }),
  )
  expect(response.status).toBe(200)
  return parseSseEvents(await response.text())
}

/** Fold events with a fixed clock sequence: the Nth event lands at N. */
function fold(state: TurnsView, events: readonly BaseEvent[]): TurnsView {
  let clock = 0
  const now = () => clock
  let view = state
  for (const event of events) {
    clock += 1
    view = reduceTurns(view, event, { now })
  }
  return view
}

// ---------------------------------------------------------------------------
// The restored side
// ---------------------------------------------------------------------------

interface TurnsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly turns: TurnsView
  readonly warnings: readonly string[]
  readonly truncated: boolean
}

async function readTurns(handler: Handler, threadId: string): Promise<TurnsBody> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}/turns`))
  expect(response.status).toBe(200)
  return (await response.json()) as TurnsBody
}

// ---------------------------------------------------------------------------
// Normalisation: the documented differences listed at the top of this file
// ---------------------------------------------------------------------------

const CLOCK_KEYS: ReadonlySet<string> = new Set(["startedAt", "settledAt", "endedAt", "updatedAt"])

function normaliseValue(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => normaliseValue(item, path))
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const isReasoning = record.kind === "reasoning"
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === "runId") out[key] = "turn"
    else if (CLOCK_KEYS.has(key) && typeof item === "number") out[key] = 0
    else if (isReasoning && (key === "id" || key === "messageId")) out[key] = "r"
    else if (key === "grant" && path.at(-1) === "approval") continue
    else out[key] = normaliseValue(item, [...path, key])
  }
  return out
}

function normalised(view: TurnsView): unknown {
  return normaliseValue(view, [])
}

/** The turn's first step as a tool step, or fails the test. */
function toolStep(view: TurnsView) {
  const step = view.turns[0]?.steps[0]
  expect(step?.kind).toBe("tool")
  if (step?.kind !== "tool") throw new Error("unreachable")
  return step
}

// ---------------------------------------------------------------------------

describe("a thread restored through GET /threads/:id/turns equals its live AG-UI view", () => {
  it("drained /search#agent run: restored deep-equals live after normalisation", async () => {
    await withAimock(
      script()
        .user("search")
        .callsTool("searchCorpus", { query: "x" })
        .replies("Found it.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())

    const events = await aguiRun(handler, {
      message: "search",
      route: "/search#agent",
      runId: "run-1",
      threadId: "t-eq-search",
    })
    expect(events.at(-1)).toMatchObject({ outcome: { type: "success" }, type: "RUN_FINISHED" })
    const live = fold({ turns: [] }, events)

    const restored = await readTurns(handler, "t-eq-search")
    expect(restored.status).toBe("idle")
    expect(restored.warnings).toEqual([])

    // The premise: both sides are a done turn with a done tool step and the text.
    expect(live.turns).toHaveLength(1)
    expect(live.turns[0]).toMatchObject({ status: "done", text: "Found it." })
    expect(toolStep(live)).toMatchObject({
      icon: "search",
      label: "Searched the corpus for x: 3 hits",
      name: "searchCorpus",
      sources: [{ href: "https://example.test/corpus", title: "Corpus" }],
      status: "done",
    })

    expect(normalised(restored.turns)).toEqual(normalised(live))
  }, 60_000)

  it("parked /park#agent run: both awaiting with the approval on the step; resumed: both done", async () => {
    await withAimock(
      script()
        .user("deploy")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())

    const parkEvents = await aguiRun(handler, {
      message: "deploy",
      route: "/park#agent",
      runId: "run-park",
      threadId: "t-eq-park",
    })
    expect(parkEvents.at(-1)).toMatchObject({
      outcome: { type: "interrupt" },
      type: "RUN_FINISHED",
    })
    const liveParked = fold({ turns: [] }, parkEvents)

    const restoredParked = await readTurns(handler, "t-eq-park")
    expect(restoredParked.status).toBe("interrupted")
    expect(restoredParked.warnings).toEqual([])

    // The premise on both sides: awaiting turn, awaiting step with the approval attached.
    for (const view of [liveParked, restoredParked.turns]) {
      expect(view.turns).toHaveLength(1)
      expect(view.turns[0]).toMatchObject({ approvals: [], status: "awaiting" })
      expect(toolStep(view)).toMatchObject({
        approval: expect.objectContaining({ kind: "tool" }),
        name: "deployProd",
        status: "awaiting",
      })
    }
    // Both carry the running display on the parked call: restored reads it off the interrupt.
    for (const view of [liveParked, restoredParked.turns]) {
      expect(toolStep(view)).toMatchObject({ icon: "run", label: "Deploying to staging…" })
    }
    const interruptId = toolStep(liveParked).approval?.interruptId
    expect(typeof interruptId).toBe("string")
    expect(toolStep(restoredParked.turns).approval?.interruptId).toBe(interruptId)

    expect(normalised(restoredParked.turns)).toEqual(normalised(liveParked))

    // Resume with "once": live folds the resuming run onto the awaiting turn.
    const resumeEvents = await aguiRun(handler, {
      message: "deploy",
      resume: [{ interruptId, payload: "once", status: "resolved" }],
      route: "/park#agent",
      runId: "run-resume",
      threadId: "t-eq-park",
    })
    expect(resumeEvents.at(-1)).toMatchObject({
      outcome: { type: "success" },
      type: "RUN_FINISHED",
    })
    const liveDone = fold(liveParked, resumeEvents)

    const restoredDone = await readTurns(handler, "t-eq-park")
    expect(restoredDone.status).toBe("idle")
    expect(restoredDone.warnings).toEqual([])

    for (const view of [liveDone, restoredDone.turns]) {
      expect(view.turns).toHaveLength(1)
      expect(view.turns[0]).toMatchObject({ status: "done", text: "Deployed." })
      expect(toolStep(view)).toMatchObject({
        icon: "run",
        label: "Deployed to staging",
        name: "deployProd",
        result: JSON.stringify("deployed to staging"),
        status: "done",
      })
      expect(toolStep(view).approval).toBeUndefined()
    }

    expect(normalised(restoredDone.turns)).toEqual(normalised(liveDone))
  }, 90_000)
})
