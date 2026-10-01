import { createServer, type Server } from "node:http"
import { HttpAgent } from "@ag-ui/client"
import { type BaseEvent, EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { ActivitySnapshotEventSchema } from "@ag-ui/core/schemas"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE, B4_SUBAGENT_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { type ToAguiOptions, toAguiEvents } from "../src/outbound.js"
import { encodeAgUiSse } from "../src/sse.js"
import type { B4AgentStreamChunk } from "../src/types.js"

// The zero-warnings gate below is the whole point of this file: the 1.0
// client warns exactly when it strips something the producer sent. The
// client honours this variable by staying silent, which would turn the gate
// into a no-op, so it is cleared for the life of this file.
const suppressedWarnings = process.env.SUPPRESS_TRANSFORMATION_WARNINGS
delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS
afterAll(() => {
  if (suppressedWarnings !== undefined) {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = suppressedWarnings
  }
})

let server: Server | undefined
afterEach(async () => {
  const currentServer = server
  server = undefined
  if (!currentServer) return
  await new Promise<void>((resolve, reject) => {
    currentServer.close((error) => (error ? reject(error) : resolve()))
  })
})

const childIdentity = {
  call_id: "c1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

const ORDINARY_TOOL_CALL_ID = "call_searchCorpus_0_0"
const STREAMED_TOOL_CALL_ID = "call_draftReply_0_2"
const STREAMED_ARGS = { subject: "Agents", body: "A short note about agents." }
const PLAN_TOOL_CALL_ID = "call_writeTodos_0_1"
// The `task` call's id is the subagent's `call_id`: that is how a subagent
// activity correlates back to the root tool call that started it.
const TASK_TOOL_CALL_ID = childIdentity.call_id

const CANNED: B4AgentStreamChunk[] = [
  { type: "token", data: "Researching" },
  {
    type: "tool_call_args",
    data: { id: STREAMED_TOOL_CALL_ID, name: "draftReply", delta: '{"subject":"Agents",' },
  },
  {
    type: "tool_call_args",
    data: { id: STREAMED_TOOL_CALL_ID, name: "draftReply", delta: '"body":"A short note' },
  },
  {
    type: "tool_call_args",
    data: { id: STREAMED_TOOL_CALL_ID, name: "draftReply", delta: ' about agents."}' },
  },
  {
    type: "tool_call",
    data: { id: STREAMED_TOOL_CALL_ID, name: "draftReply", input: STREAMED_ARGS },
  },
  { type: "tool_result", data: { id: STREAMED_TOOL_CALL_ID, name: "draftReply", output: "ok" } },
  {
    type: "tool_call",
    data: { id: ORDINARY_TOOL_CALL_ID, name: "searchCorpus", input: { query: "agents" } },
  },
  {
    type: "tool_result",
    data: {
      id: ORDINARY_TOOL_CALL_ID,
      name: "searchCorpus",
      output: [{ path: "corpus/a.md" }],
    },
  },
  {
    type: "tool_call",
    data: {
      id: PLAN_TOOL_CALL_ID,
      name: "writeTodos",
      input: { todos: [{ content: "search", status: "completed" }] },
    },
  },
  {
    type: "plan_update",
    data: {
      tool_call_id: PLAN_TOOL_CALL_ID,
      todos: [{ content: "search", status: "completed" }],
    },
  },
  {
    type: "tool_result",
    data: { id: PLAN_TOOL_CALL_ID, name: "writeTodos", output: "Updated todo list" },
  },
  {
    type: "tool_call",
    data: {
      id: TASK_TOOL_CALL_ID,
      name: "task",
      input: { subagent_type: "researcher", description: "read source" },
    },
  },
  { type: "subagent.start", data: childIdentity },
  {
    type: "subagent.plan_update",
    data: {
      ...childIdentity,
      todos: [{ content: "read source", status: "in_progress" }],
    },
  },
  {
    type: "subagent.tool_call",
    data: {
      ...childIdentity,
      id: "child-tool-1",
      tool: "readDoc",
      input: "not public input",
    },
  },
  {
    type: "subagent.tool_result",
    data: { ...childIdentity, id: "child-tool-1", output: "not public output" },
  },
  { type: "subagent.message", data: { ...childIdentity, content: "not public message" } },
  { type: "subagent.end", data: { ...childIdentity, final_message: "not public final" } },
  {
    type: "tool_result",
    data: { id: TASK_TOOL_CALL_ID, name: "task", output: "not public final" },
  },
  { type: "token", data: " done. [corpus/a.md]" },
  { type: "done", data: { messages: [] } },
]

async function* toAsync(items: readonly B4AgentStreamChunk[]) {
  yield* items
}

interface CannedRun {
  readonly stream: () => AsyncIterable<B4AgentStreamChunk>
  readonly options?: ToAguiOptions
  /** Test-only: rewrite an event before it is encoded, to prove the gate bites. */
  readonly mutate?: (event: BaseEvent) => BaseEvent
}

/** The fixture server: answers each POST with the next canned run, and records every request body. */
async function startCannedServer(runs: readonly CannedRun[]): Promise<{
  readonly url: string
  readonly bodies: unknown[]
}> {
  const queue = [...runs]
  const bodies: unknown[] = []
  const cannedServer = createServer((req, res) => {
    void (async () => {
      const raw: Buffer[] = []
      for await (const piece of req) raw.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece))
      bodies.push(JSON.parse(Buffer.concat(raw).toString("utf8")))
      const run = queue.shift()
      if (!run) throw new Error("more runs requested than canned")
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const events = toAguiEvents(
        run.stream(),
        { threadId: "t1", runId: `r${bodies.length}` },
        { idFactory: createCounterIdFactory(), ...run.options },
      )
      for await (const event of events) {
        res.write(encodeAgUiSse(run.mutate ? run.mutate(event) : event))
      }
      res.end()
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    cannedServer.once("error", onError)
    cannedServer.listen(0, "127.0.0.1", () => {
      cannedServer.off("error", onError)
      resolve()
    })
  })
  server = cannedServer
  const address = cannedServer.address()
  if (!address || typeof address === "string") throw new Error("Canned server has no TCP address")
  return { url: `http://127.0.0.1:${address.port}`, bodies }
}

/**
 * Run `fn` with `console.warn` captured, and fail if it warned: a 1.0 client
 * warns exactly when it strips or translates something the producer sent, and
 * B4.run must send nothing that gets stripped.
 */
async function withNoWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    const result = await fn()
    expect(warn.mock.calls, "the 1.0 client stripped or translated something").toEqual([])
    return result
  } finally {
    warn.mockRestore()
  }
}

function newAgent(url: string): HttpAgent {
  return new HttpAgent({
    url,
    threadId: "t1",
    initialMessages: [{ id: "1", role: "user", content: "research agents" }],
  })
}

/**
 * Drive the REAL client pipeline — `runAgent`, not a bare `run()` — so
 * CompatibilityBoundary → enforceEvents → chunk expansion → verifyEvents all
 * run, under `withNoWarnings`.
 */
async function runThroughClient(url: string, parameters: Parameters<HttpAgent["runAgent"]>[0]) {
  return withNoWarnings(async () => {
    const agent = newAgent(url)
    const events: BaseEvent[] = []
    const result = await agent.runAgent(parameters, {
      onEvent: ({ event }) => {
        events.push(event)
      },
    })
    return { agent, events, result }
  })
}

it("a full turn passes 1.0 enforcement with nothing stripped", async () => {
  const { url } = await startCannedServer([{ stream: () => toAsync(CANNED) }])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)

  // The two built-in orchestration calls present as activities only: no generic
  // tool frame anywhere in the stream references their ids.
  const toolEvents = events.filter(
    (event) =>
      event.type === EventType.TOOL_CALL_START ||
      event.type === EventType.TOOL_CALL_ARGS ||
      event.type === EventType.TOOL_CALL_END ||
      event.type === EventType.TOOL_CALL_RESULT,
  )
  expect(toolEvents.map((event) => event.toolCallId)).not.toContain(PLAN_TOOL_CALL_ID)
  expect(toolEvents.map((event) => event.toolCallId)).not.toContain(TASK_TOOL_CALL_ID)
  expect(
    toolEvents
      .filter((event) => event.type === EventType.TOOL_CALL_START)
      .map((event) => event.toolCallName),
  ).toEqual(["draftReply", "searchCorpus"])

  // A streamed call reaches the client as several args deltas whose
  // concatenation is exactly the single delta a non-streamed call carries.
  const streamedFrames = toolEvents.filter((event) => event.toolCallId === STREAMED_TOOL_CALL_ID)
  expect(streamedFrames.map((event) => event.type)).toEqual([
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
  ])
  expect(
    streamedFrames
      .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
      .map((event) => event.delta)
      .join(""),
  ).toBe(JSON.stringify(STREAMED_ARGS))

  // The ordinary tool keeps its full, correlated frame sequence.
  const ordinaryFrames = toolEvents.filter((event) => event.toolCallId === ORDINARY_TOOL_CALL_ID)
  expect(ordinaryFrames.map((event) => event.type)).toEqual([
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
  ])

  const activities = events
    .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    .map((event) => ActivitySnapshotEventSchema.parse(event))
  expect(activities.length).toBeGreaterThan(0)
  expect(new Set(activities.map((activity) => activity.activityType))).toEqual(
    new Set([B4_PLAN_ACTIVITY_TYPE, B4_SUBAGENT_ACTIVITY_TYPE]),
  )
  const serializedActivityContent = JSON.stringify(activities.map((activity) => activity.content))
  for (const privateValue of [
    "not public",
    childIdentity.route_id,
    childIdentity.call_id,
    "child-tool-1",
  ]) {
    expect(serializedActivityContent).not.toContain(privateValue)
  }
  expect(
    events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join(""),
  ).toBe("Researching done. [corpus/a.md]")
  expect(kinds).not.toContain(EventType.ACTIVITY_DELTA)
  expect(kinds).not.toContain(EventType.STATE_SNAPSHOT)
  expect(kinds).not.toContain(EventType.CUSTOM)
  expect(kinds).not.toContain(EventType.RAW)
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
})

it("an approval interrupt keeps its grant in metadata, and the resume carries it back there", async () => {
  const { url, bodies } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          {
            type: "interrupt",
            data: { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "b4ag_xyz" },
          },
        ]),
    },
    {
      stream: () =>
        toAsync([
          { type: "token", data: "approved" },
          { type: "done", data: {} },
        ]),
    },
  ])
  const { agent, events } = await runThroughClient(url, { runId: "r1" })
  const last = events[events.length - 1]
  expect(last).toMatchObject({
    type: EventType.RUN_FINISHED,
    outcome: { type: "interrupt", interrupts: [{ metadata: { grant: "b4ag_xyz" } }] },
  })
  expect(last).not.toHaveProperty("outcome.interrupts.0.grant")
  expect(agent.pendingInterrupts).toHaveLength(1)

  await withNoWarnings(() =>
    agent.runAgent({
      runId: "r2",
      resume: [
        {
          interruptId: "perm-1",
          status: "resolved",
          payload: "once",
          metadata: { grant: "b4ag_xyz" },
        },
      ],
    }),
  )
  expect(bodies[1]).toHaveProperty("protocolVersion", PROTOCOL_VERSION)
  expect(bodies[1]).toHaveProperty("resume.0.metadata", { grant: "b4ag_xyz" })
  expect(bodies[1]).not.toHaveProperty("resume.0.grant")
})

it("a client-tool park ends as success naming the pending call", async () => {
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "tool_call", data: { id: "call_open", name: "openPanel", input: { id: 7 } } },
        ]),
      options: { pendingToolCallIds: () => ["call_open"] },
    },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events[events.length - 1]).toMatchObject({
    type: EventType.RUN_FINISHED,
    outcome: { type: "success", pendingToolCallIds: ["call_open"] },
  })
})

it("a cancelled run ends with the cancelled outcome and no RUN_ERROR", async () => {
  async function* abortedAfterOneToken(): AsyncIterable<B4AgentStreamChunk> {
    yield { type: "token", data: "partial" }
    throw new Error("AG-UI request aborted")
  }
  const { url } = await startCannedServer([
    { stream: abortedAfterOneToken, options: { cancelled: () => true } },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events.map((event) => event.type)).not.toContain(EventType.RUN_ERROR)
  expect(events[events.length - 1]).toMatchObject({
    type: EventType.RUN_FINISHED,
    outcome: { type: "cancelled" },
  })
})

it("an upstream error is RUN_ERROR with its code intact", async () => {
  // biome-ignore lint/correctness/useYield: a stream that fails before its first chunk
  async function* failing(): AsyncIterable<B4AgentStreamChunk> {
    throw Object.assign(new Error("after rejected"), { code: "after_rejected" })
  }
  const { url } = await startCannedServer([{ stream: failing }])
  // @ag-ui/client 1.0.1's runAgent RESOLVES on a RUN_ERROR (no result, no new
  // messages) rather than rejecting; what matters is that the event reached
  // the subscriber with its code, and nothing was stripped on the way.
  const { events, result } = await runThroughClient(url, { runId: "r1" })
  expect(result).toEqual({ result: undefined, newMessages: [] })
  expect(events[events.length - 1]).toMatchObject({
    type: EventType.RUN_ERROR,
    message: "after rejected",
    code: "after_rejected",
  })
})

it("the gate itself bites: an unknown key on an event fails the run", async () => {
  async function* tagged(): AsyncIterable<B4AgentStreamChunk> {
    yield { type: "done", data: {} }
  }
  const { url } = await startCannedServer([
    {
      stream: tagged,
      mutate: (event) => (event.type === EventType.RUN_STARTED ? { ...event, bogus: 1 } : event),
    },
  ])
  await expect(runThroughClient(url, { runId: "r1" })).rejects.toThrow(/stripped or translated/)
})
