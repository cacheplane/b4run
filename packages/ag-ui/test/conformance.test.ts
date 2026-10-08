import { createServer, type Server } from "node:http"
import { HttpAgent } from "@ag-ui/client"
import { type BaseEvent, EventType, PROTOCOL_VERSION, type RunAgentInput } from "@ag-ui/core"
import { ActivitySnapshotEventSchema } from "@ag-ui/core/schemas"
import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { type ToAguiOptions, toAguiEvents } from "../src/outbound.js"
import { agUiContentType, encodeAgUiEvent } from "../src/sse.js"
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

const PERMISSION_RESPONSE = { type: "string", enum: ["once", "always", "deny"] }
const ORDINARY_TOOL_CALL_ID = "call_searchCorpus_0_0"
const STREAMED_TOOL_CALL_ID = "call_draftReply_0_2"
const STREAMED_ARGS = { subject: "Agents", body: "A short note about agents." }
const PLAN_TOOL_CALL_ID = "call_writeTodos_0_1"
const PARTS_TOOL_CALL_ID = "call_render_0_3"
const PARTS_RESULT = [
  { type: "text", text: "chart" },
  { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
]
const DROPPED = {
  provider: "openai",
  model: "gpt-5-mini",
  parts: [{ index: 0, type: "video", source: "url", reason: "modality_unsupported" }],
}
// The `task` call's id is the subagent's `call_id`: that is how a subagent
// activity correlates back to the root tool call that started it.
const TASK_TOOL_CALL_ID = childIdentity.call_id

const REASONING_TEXT = "The user wants sources; search first."

const CANNED: B4AgentStreamChunk[] = [
  { type: "reasoning", data: REASONING_TEXT },
  { type: "token", data: "Researching" },
  {
    type: "usage",
    data: {
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
    },
  },
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
    type: "step",
    data: {
      tool_call_id: ORDINARY_TOOL_CALL_ID,
      status: "running",
      icon: "search",
      label: "Searching the corpus for “agents”",
    },
  },
  {
    type: "step",
    data: {
      tool_call_id: ORDINARY_TOOL_CALL_ID,
      status: "completed",
      icon: "search",
      label: "Searched the corpus for “agents”",
      sources: [{ title: "corpus/a.md" }],
    },
  },
  {
    type: "tool_result",
    data: {
      id: ORDINARY_TOOL_CALL_ID,
      name: "searchCorpus",
      output: [{ path: "corpus/a.md" }],
    },
  },
  { type: "content_parts_dropped", data: DROPPED },
  { type: "tool_call", data: { id: PARTS_TOOL_CALL_ID, name: "renderChart", input: {} } },
  {
    type: "tool_result",
    data: { id: PARTS_TOOL_CALL_ID, name: "renderChart", output: PARTS_RESULT },
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
    type: "subagent.usage",
    data: {
      ...childIdentity,
      provider: "openai",
      model: "gpt-5-nano",
      usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
  },
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
      name: "readDoc",
      input: "not public input",
    },
  },
  {
    type: "subagent.tool_result",
    data: { ...childIdentity, id: "child-tool-1", name: "readDoc", output: "not public output" },
  },
  {
    type: "subagent.token",
    data: { ...childIdentity, data: "not public message", messageId: "child-model" },
  },
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
  /** Test-only: the run id this canned run reports; defaults to its 1-based position. */
  readonly runId?: string
}

/** The fixture server: answers each POST with the next canned run, and records every request body. */
async function startCannedServer(runs: readonly CannedRun[]): Promise<{
  readonly url: string
  readonly bodies: unknown[]
  readonly contentTypes: string[]
}> {
  const queue = [...runs]
  const bodies: unknown[] = []
  const contentTypes: string[] = []
  const cannedServer = createServer((req, res) => {
    void (async () => {
      const raw: Buffer[] = []
      for await (const piece of req) raw.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece))
      bodies.push(JSON.parse(Buffer.concat(raw).toString("utf8")))
      const run = queue.shift()
      if (!run) throw new Error("more runs requested than canned")
      const accept = req.headers.accept
      const contentType = agUiContentType(accept)
      contentTypes.push(contentType)
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" })
      const events = toAguiEvents(
        run.stream(),
        { threadId: "t1", runId: run.runId ?? `r${bodies.length}` },
        { idFactory: createCounterIdFactory(), ...run.options },
      )
      for await (const event of events) {
        res.write(encodeAgUiEvent(run.mutate ? run.mutate(event) : event, accept))
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
  return { url: `http://127.0.0.1:${address.port}`, bodies, contentTypes }
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

/**
 * `HttpAgent` names `text/event-stream` after spreading its constructor
 * headers, so asking for the binary binding means overriding `requestInit`.
 * Parsing needs no override: the client picks its parser from the response
 * content type.
 */
class BinaryHttpAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit(input)
    return {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Accept: AGUI_MEDIA_TYPE },
    }
  }
}

function newAgent(url: string, binding: "sse" | "protobuf" = "sse"): HttpAgent {
  const params: ConstructorParameters<typeof HttpAgent>[0] = {
    url,
    threadId: "t1",
    initialMessages: [{ id: "1", role: "user", content: "research agents" }],
  }
  return binding === "protobuf" ? new BinaryHttpAgent(params) : new HttpAgent(params)
}

/**
 * Drive the REAL client pipeline — `runAgent`, not a bare `run()` — so
 * CompatibilityBoundary → enforceEvents → chunk expansion → verifyEvents all
 * run, under `withNoWarnings`.
 */
async function runThroughClient(
  url: string,
  parameters: Parameters<HttpAgent["runAgent"]>[0],
  binding: "sse" | "protobuf" = "sse",
) {
  return withNoWarnings(async () => {
    const agent = newAgent(url, binding)
    const events: BaseEvent[] = []
    // Only collect here: the client logs and swallows a throwing subscriber, so assertions belong after runAgent returns.
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
  const { agent, events } = await runThroughClient(url, { runId: "r1" })
  expect(events[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)

  // writeTodos presents as the plan activity only; the task call is an ordinary
  // tool call whose subagent is presented with SUBAGENT_* and attribution.
  const toolEvents = events.filter(
    (event) =>
      event.type === EventType.TOOL_CALL_START ||
      event.type === EventType.TOOL_CALL_ARGS ||
      event.type === EventType.TOOL_CALL_END ||
      event.type === EventType.TOOL_CALL_RESULT,
  )
  expect(toolEvents.map((event) => event.toolCallId)).not.toContain(PLAN_TOOL_CALL_ID)
  expect(
    toolEvents
      .filter((event) => event.type === EventType.TOOL_CALL_START)
      .map((event) => event.toolCallName),
  ).toEqual(["draftReply", "searchCorpus", "renderChart", "task", "readDoc"])

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

  // A tool that returned parts reaches the client with parts as its content,
  // unflattened.
  const partsFrames = toolEvents.filter((event) => event.toolCallId === PARTS_TOOL_CALL_ID)
  expect(partsFrames.map((event) => event.type)).toEqual([
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
  ])
  expect(partsFrames[partsFrames.length - 1]).toMatchObject({ content: PARTS_RESULT })
  // ...and the client keeps it that way: `@ag-ui/client` stores the tool
  // message with the part array as its content, which is what a UI reads.
  expect(
    agent.messages.find(
      (message) => message.role === "tool" && message.toolCallId === PARTS_TOOL_CALL_ID,
    ),
  ).toMatchObject({ content: PARTS_RESULT })

  // Parts the model could not take are announced, once, as a vendor CUSTOM event.
  const custom = events.filter((event) => event.type === EventType.CUSTOM)
  // B4.run's vendor events all use the `b4.` prefix: `b4.step` and `b4.content_parts_dropped`.
  for (const event of custom) {
    expect(event).toMatchObject({
      name: expect.stringMatching(/^b4\.(step|content_parts_dropped)$/),
    })
  }
  const steps = custom.filter((event) => event.name === "b4.step")
  expect(steps.map((event) => event.value)).toEqual([
    {
      toolCallId: ORDINARY_TOOL_CALL_ID,
      status: "running",
      icon: "search",
      label: "Searching the corpus for “agents”",
    },
    {
      toolCallId: ORDINARY_TOOL_CALL_ID,
      status: "completed",
      icon: "search",
      label: "Searched the corpus for “agents”",
      sources: [{ title: "corpus/a.md" }],
    },
  ])
  for (const step of steps) expect(step).not.toHaveProperty("subagentRunId")
  expect(custom.filter((event) => event.name !== "b4.step")).toEqual([
    expect.objectContaining({ name: "b4.content_parts_dropped", value: DROPPED }),
  ])
  // The client keeps the parts as the tool message's content.
  expect(
    agent.messages.find(
      (message) => message.role === "tool" && message.toolCallId === PARTS_TOOL_CALL_ID,
    ),
  ).toMatchObject({ content: PARTS_RESULT })

  // The subagent: announced before anything is attributed to it, every event
  // in between carries its id, closed with its result before the run ends.
  const started = kinds.indexOf(EventType.SUBAGENT_STARTED)
  const finished = kinds.indexOf(EventType.SUBAGENT_FINISHED)
  expect(started).toBeGreaterThan(-1)
  expect(finished).toBeGreaterThan(started)
  expect(events[started]).toMatchObject({
    subagentRunId: childIdentity.call_id,
    name: childIdentity.subagent,
    parentToolCallId: TASK_TOOL_CALL_ID,
  })
  expect(events[finished]).toMatchObject({
    subagentRunId: childIdentity.call_id,
    result: "not public final",
    outcome: { type: "success" },
  })
  for (const event of events.slice(started + 1, finished)) {
    expect(event).toHaveProperty("subagentRunId", childIdentity.call_id)
  }
  const attributedKinds = events
    .filter((event) => event.subagentRunId === childIdentity.call_id)
    .map((event) => event.type)
  expect(attributedKinds).toContain(EventType.TEXT_MESSAGE_CONTENT)
  expect(attributedKinds).toContain(EventType.TOOL_CALL_START)
  expect(attributedKinds).toContain(EventType.TOOL_CALL_RESULT)
  expect(attributedKinds).toContain(EventType.ACTIVITY_SNAPSHOT)
  for (const event of toolEvents) {
    if (event.toolCallId === "child-tool-1") {
      expect(event).toHaveProperty("subagentRunId", childIdentity.call_id)
    } else {
      expect(event).not.toHaveProperty("subagentRunId")
    }
  }
  // Root and child plans are both `b4.plan`, under their own stable ids.
  const activities = events
    .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    .map((event) => ActivitySnapshotEventSchema.parse(event))
  expect(new Set(activities.map((activity) => activity.activityType))).toEqual(
    new Set([B4_PLAN_ACTIVITY_TYPE]),
  )
  expect(activities.map((activity) => activity.messageId).sort()).toEqual(
    [`b4:plan:${childIdentity.call_id}`, "b4:plan:r1"].sort(),
  )
  // The child's prose is in the transcript as its own tagged message; the
  // root's text is exactly the root's.
  // (The child's tool-call-bearing assistant message has no content; the prose one does.)
  expect(
    agent.messages
      .filter(
        (message) =>
          message.role === "assistant" && message.subagentRunId === childIdentity.call_id,
      )
      .map((message) => message.content)
      .filter((content) => typeof content === "string"),
  ).toEqual(["not public message"])
  expect(
    events
      .filter(
        (event) => event.type === EventType.TEXT_MESSAGE_CONTENT && !("subagentRunId" in event),
      )
      .map((event) => event.delta)
      .join(""),
  ).toBe("Researching done. [corpus/a.md]")
  // Reasoning survives enforcement as a span plus a `role: "reasoning"`
  // message, both closed before the first tool frame, and the client keeps
  // the message in its transcript.
  expect(kinds).toContain(EventType.REASONING_START)
  expect(kinds).toContain(EventType.REASONING_MESSAGE_START)
  expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(
    kinds.indexOf(EventType.TOOL_CALL_START),
  )
  expect(
    events
      .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join(""),
  ).toBe(REASONING_TEXT)
  expect(agent.messages.filter((message) => message.role === "reasoning")).toEqual([
    expect.objectContaining({ content: REASONING_TEXT }),
  ])
  expect(kinds).not.toContain(EventType.ACTIVITY_DELTA)
  expect(kinds).not.toContain(EventType.STATE_SNAPSHOT)
  expect(kinds).not.toContain(EventType.RAW)
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
  // Usage survives 1.0 enforcement intact: one entry per provider+model, the
  // child's call included, the protocol's camelCase keys.
  expect(events[events.length - 1]).toMatchObject({
    usage: [
      {
        provider: "openai",
        model: "gpt-5-mini",
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
      },
      { provider: "openai", model: "gpt-5-nano", inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    ],
  })
})

it("the HTTP+protobuf binding passes 1.0 enforcement with the same events", async () => {
  const { url, contentTypes } = await startCannedServer([
    { runId: "r1", stream: () => toAsync(CANNED) },
    { runId: "r1", stream: () => toAsync(CANNED) },
  ])
  const sse = await runThroughClient(url, { runId: "r1" })
  const binary = await runThroughClient(url, { runId: "r1" }, "protobuf")
  expect(contentTypes).toEqual(["text/event-stream", AGUI_MEDIA_TYPE])

  // Same turn, same run id, two bindings: the client's protobuf parser yields
  // exactly what its SSE parser yields. Only the wall-clock timestamp differs.
  const strip = (events: BaseEvent[]) =>
    events.map(({ timestamp: _timestamp, rawEvent: _raw, ...event }) => event)
  expect(binary.events.length).toBe(sse.events.length)
  expect(strip(binary.events)).toEqual(strip(sse.events))
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

it("reasoning open at an interrupt is closed before RUN_FINISHED, and the resume starts fresh", async () => {
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "reasoning", data: "need approval", messageId: "m1" },
          {
            type: "interrupt",
            data: { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "b4ag_xyz" },
          },
        ]),
    },
    {
      stream: () =>
        toAsync([
          { type: "reasoning", data: "approved, continuing", messageId: "m2" },
          { type: "token", data: "done", messageId: "m2" },
          { type: "message_end", data: { messageId: "m2" } },
          { type: "done", data: {} },
        ]),
      // Message ids are per thread, not per run: the production factory mints
      // UUIDs, while the canned server's counter restarts every request, so
      // the second run would otherwise reuse `rsn-1` and overwrite the first.
      options: { idFactory: (kind) => `r2-${kind}` },
    },
  ])
  const { agent, events } = await runThroughClient(url, { runId: "r1" })
  expect(events.map((event) => event.type).slice(-3)).toEqual([
    EventType.REASONING_MESSAGE_END,
    EventType.REASONING_END,
    EventType.RUN_FINISHED,
  ])
  expect(events[events.length - 1]).toMatchObject({ outcome: { type: "interrupt" } })

  const resumed: BaseEvent[] = []
  await withNoWarnings(() =>
    agent.runAgent(
      {
        runId: "r2",
        resume: [
          {
            interruptId: "perm-1",
            status: "resolved",
            payload: "once",
            metadata: { grant: "b4ag_xyz" },
          },
        ],
      },
      {
        onEvent: ({ event }) => {
          resumed.push(event)
        },
      },
    ),
  )
  const kinds = resumed.map((event) => event.type)
  expect(kinds.filter((kind) => kind === EventType.REASONING_START)).toHaveLength(1)
  expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(
    kinds.indexOf(EventType.TEXT_MESSAGE_END),
  )
  expect(kinds.at(-1)).toBe(EventType.RUN_FINISHED)
  expect(agent.messages.filter((message) => message.role === "reasoning")).toHaveLength(2)
})

it("a child's two-id permission interrupt survives the 1.0 client with subagentRunId and responseSchema", async () => {
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "subagent.start", data: childIdentity },
          {
            type: "interrupt",
            data: {
              interruptId: "perm-2",
              type: "permission-request",
              kind: "command",
              callId: childIdentity.call_id,
              toolCallId: "child-call-9",
            },
          },
        ]),
    },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events.at(-2)).toMatchObject({
    type: EventType.SUBAGENT_FINISHED,
    subagentRunId: childIdentity.call_id,
    outcome: { type: "suspended", interruptIds: ["perm-2"] },
  })
  const finished = events.at(-1) as {
    type: string
    outcome: { type: string; interrupts: Record<string, unknown>[] }
  }
  expect(finished.type).toBe(EventType.RUN_FINISHED)
  expect(finished.outcome.type).toBe("interrupt")
  expect(finished.outcome.interrupts[0]).toMatchObject({
    id: "perm-2",
    toolCallId: "child-call-9",
    subagentRunId: childIdentity.call_id,
    responseSchema: PERMISSION_RESPONSE,
  })
})

it("a child interrupt suspends the subagent, tags the interrupt, and the resume re-announces it", async () => {
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "subagent.start", data: childIdentity },
          { type: "subagent.token", data: { ...childIdentity, data: "asking", messageId: "cm1" } },
          {
            type: "interrupt",
            data: {
              interruptId: "perm-1",
              kind: "tool",
              callId: childIdentity.call_id,
              grant: "b4ag_xyz",
            },
          },
        ]),
    },
    {
      stream: () =>
        toAsync([
          { type: "subagent.start", data: childIdentity },
          {
            type: "subagent.token",
            data: { ...childIdentity, data: "approved", messageId: "cm2" },
          },
          { type: "subagent.end", data: { ...childIdentity, final_message: "approved" } },
          { type: "done", data: {} },
        ]),
      options: { idFactory: (kind) => `r2-${kind}` },
    },
  ])
  const { agent, events } = await runThroughClient(url, { runId: "r1" })
  const kinds = events.map((event) => event.type)
  expect(kinds.slice(-2)).toEqual([EventType.SUBAGENT_FINISHED, EventType.RUN_FINISHED])
  expect(events.at(-2)).toMatchObject({
    subagentRunId: childIdentity.call_id,
    outcome: { type: "suspended", interruptIds: ["perm-1"] },
  })
  expect(events.at(-1)).toMatchObject({
    outcome: {
      type: "interrupt",
      interrupts: [
        { id: "perm-1", subagentRunId: childIdentity.call_id, metadata: { grant: "b4ag_xyz" } },
      ],
    },
  })
  expect(kinds.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
    kinds.indexOf(EventType.SUBAGENT_FINISHED),
  )

  const resumed: BaseEvent[] = []
  await withNoWarnings(() =>
    agent.runAgent(
      {
        runId: "r2",
        resume: [
          {
            interruptId: "perm-1",
            status: "resolved",
            payload: "once",
            metadata: { grant: "b4ag_xyz" },
          },
        ],
      },
      {
        onEvent: ({ event }) => {
          resumed.push(event)
        },
      },
    ),
  )
  const resumedKinds = resumed.map((event) => event.type)
  expect(resumedKinds.filter((kind) => kind === EventType.SUBAGENT_STARTED)).toHaveLength(1)
  expect(resumedKinds.indexOf(EventType.SUBAGENT_FINISHED)).toBeLessThan(
    resumedKinds.indexOf(EventType.RUN_FINISHED),
  )
  expect(resumed.find((event) => event.type === EventType.SUBAGENT_FINISHED)).toMatchObject({
    result: "approved",
    outcome: { type: "success" },
  })
})

it("a cancel with a subagent open closes it with SUBAGENT_ERROR before the cancelled outcome", async () => {
  async function* abortedMidChild(): AsyncIterable<B4AgentStreamChunk> {
    yield { type: "subagent.start", data: childIdentity }
    yield { type: "subagent.token", data: { ...childIdentity, data: "partial", messageId: "cm1" } }
    throw new Error("AG-UI request aborted")
  }
  const { url } = await startCannedServer([
    { stream: abortedMidChild, options: { cancelled: () => true } },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  const kinds = events.map((event) => event.type)
  expect(kinds.slice(-2)).toEqual([EventType.SUBAGENT_ERROR, EventType.RUN_FINISHED])
  expect(events.at(-2)).toMatchObject({ subagentRunId: childIdentity.call_id, code: "cancelled" })
  expect(events.at(-1)).toMatchObject({ outcome: { type: "cancelled" } })
})

it("a nested subagent names its parent and both close before the run ends", async () => {
  const grandchild = {
    call_id: "c2",
    subagent: "reader",
    route_id: "/research#reader",
    depth: 2,
    parent_call_id: childIdentity.call_id,
  } as const
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "subagent.start", data: childIdentity },
          { type: "subagent.start", data: grandchild },
          { type: "subagent.token", data: { ...grandchild, data: "deep", messageId: "gm1" } },
          { type: "subagent.end", data: { ...grandchild, final_message: "deep" } },
          { type: "subagent.end", data: { ...childIdentity, final_message: "shallow" } },
          { type: "done", data: {} },
        ]),
    },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  const starts = events.filter((event) => event.type === EventType.SUBAGENT_STARTED)
  expect(starts[1]).toMatchObject({
    subagentRunId: "c2",
    parentSubagentRunId: childIdentity.call_id,
  })
  expect(
    events
      .filter((event) => event.type === EventType.SUBAGENT_FINISHED)
      .map((event) => event.subagentRunId),
  ).toEqual(["c2", childIdentity.call_id])
  expect(events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveProperty(
    "subagentRunId",
    "c2",
  )
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
    yield {
      type: "usage",
      data: {
        provider: "openai",
        model: "gpt-5-mini",
        usage_metadata: { input_tokens: 4, output_tokens: 1 },
      },
    }
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
    usage: [{ provider: "openai", model: "gpt-5-mini", inputTokens: 4, outputTokens: 1 }],
  })
})

it("an upstream error is RUN_ERROR with its code intact", async () => {
  async function* failing(): AsyncIterable<B4AgentStreamChunk> {
    yield { type: "usage", data: { usage_metadata: { input_tokens: 2, output_tokens: 0 } } }
    throw Object.assign(new Error("after rejected"), { code: "after_rejected" })
  }
  const { url } = await startCannedServer([{ stream: failing }])
  // @ag-ui/client 1.0.2's runAgent RESOLVES on a RUN_ERROR rather than
  // rejecting; what matters is that the event reached the subscriber with its
  // code, and nothing was stripped on the way.
  const { events, result } = await runThroughClient(url, { runId: "r1" })
  expect(result).toBeDefined()
  expect(events[events.length - 1]).toMatchObject({
    type: EventType.RUN_ERROR,
    message: "after rejected",
    code: "after_rejected",
    usage: [{ inputTokens: 2, outputTokens: 0 }],
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

it("every tool call names its model message: the client files an invocation's text and calls together", async () => {
  const child = { ...childIdentity, call_id: "task-1" }
  const stream: B4AgentStreamChunk[] = [
    // Invocation m1: text, then two calls announced at its end.
    { type: "token", data: "Let me look.", messageId: "m1" },
    { type: "message_end", data: { messageId: "m1" } },
    { type: "tool_call", data: { id: "a", name: "search", input: {}, messageId: "m1" } },
    { type: "tool_call", data: { id: "b", name: "search", input: {}, messageId: "m1" } },
    { type: "tool_result", data: { id: "a", name: "search", output: "1" } },
    { type: "tool_result", data: { id: "b", name: "search", output: "2" } },
    // Invocation m2 is tool-only: no TEXT_MESSAGE_START ever names it.
    { type: "tool_call", data: { id: "task-1", name: "task", input: {}, messageId: "m2" } },
    { type: "subagent.start", data: child },
    {
      type: "subagent.tool_call",
      data: { ...child, id: "c", name: "readDoc", input: {}, messageId: "cm1" },
    },
    { type: "subagent.tool_result", data: { ...child, id: "c", name: "readDoc", output: "x" } },
    { type: "subagent.end", data: { ...child, final_message: "read" } },
    { type: "tool_result", data: { id: "task-1", name: "task", output: "read" } },
    { type: "token", data: "Done.", messageId: "m3" },
    { type: "message_end", data: { messageId: "m3" } },
    { type: "done", data: {} },
  ]
  const { url } = await startCannedServer([{ stream: () => toAsync(stream) }])
  const { agent, events } = await runThroughClient(url, { runId: "r1" })

  const starts = events.filter((event) => event.type === EventType.TOOL_CALL_START)
  for (const start of starts) expect(start.parentMessageId).toEqual(expect.any(String))
  const texts = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)
  // m1's calls name the message its text was framed with.
  expect(starts[0]?.parentMessageId).toBe(texts[0]?.messageId)
  expect(starts[1]?.parentMessageId).toBe(texts[0]?.messageId)

  const assistants = agent.messages.filter((message) => message.role === "assistant")
  expect(
    assistants.map((message) => [
      message.content ?? "",
      message.toolCalls?.map((call) => call.id) ?? [],
    ]),
  ).toEqual([
    ["Let me look.", ["a", "b"]],
    ["", ["task-1"]],
    ["", ["c"]],
    ["Done.", []],
  ])
  // The child's call sits in a message the child owns.
  expect(assistants[2]).toMatchObject({ subagentRunId: "task-1" })
  expect(assistants[1]).not.toHaveProperty("subagentRunId")
})
