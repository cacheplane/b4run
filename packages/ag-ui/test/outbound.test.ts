import { type BaseEvent, EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { ActivitySnapshotEventSchema, ToolCallResultEventSchema } from "@ag-ui/core/schemas"
import { describe, expect, test } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { toAguiEvents, toolResultView } from "../src/outbound.js"
import { encodeAgUiEvent } from "../src/sse.js"
import type { B4AgentStreamChunk } from "../src/types.js"

const PERMISSION_RESPONSE = { type: "string", enum: ["once", "always", "deny"] }

const CTX = { threadId: "th-1", runId: "rn-1" }
const CHILD = {
  call_id: "call-1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

async function collect(chunks: B4AgentStreamChunk[]) {
  const out = []
  for await (const ev of toAguiEvents(toAsync(chunks), CTX, {
    idFactory: createCounterIdFactory(),
  })) {
    out.push(ev)
  }
  return out
}

async function* toAsync(items: B4AgentStreamChunk[]) {
  for (const item of items) yield item
}

describe("toAguiEvents", () => {
  test("RUN_STARTED declares the producer's protocol version", async () => {
    const [first] = await collect([{ type: "done", data: {} }])
    expect(first).toEqual({
      type: EventType.RUN_STARTED,
      threadId: "th-1",
      runId: "rn-1",
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(PROTOCOL_VERSION).toBe("1.0")
  })

  test("text-only stream: run start, framed message, run finished success", async () => {
    const events = await collect([
      { type: "token", data: "Hel" },
      { type: "token", data: "lo" },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "th-1",
        runId: "rn-1",
        protocolVersion: PROTOCOL_VERSION,
      },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        result: {},
        outcome: { type: "success" },
      },
    ])
  })

  test("tool call + result: correlated by upstream id, single args frame", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-abc", name: "greet", input: { name: "World" } } },
      { type: "tool_result", data: { id: "run-abc", name: "greet", output: { greeting: "hi" } } },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "th-1",
        runId: "rn-1",
        protocolVersion: PROTOCOL_VERSION,
      },
      { type: EventType.TOOL_CALL_START, toolCallId: "run-abc", toolCallName: "greet" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "run-abc", delta: '{"name":"World"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "run-abc" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr-1",
        toolCallId: "run-abc",
        content: '{"greeting":"hi"}',
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        result: {},
        outcome: { type: "success" },
      },
    ])
  })

  test("a failing tool's error ToolMessage reaches TOOL_CALL_RESULT under the same toolCallId", async () => {
    // What @b4run/langchain emits for a thrown tool: the error ToolMessage the
    // model receives, keyed by the model's tool-call id. The wire carries the
    // text the model saw, never the serialized message object.
    const errorToolMessage = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        status: "error",
        content: "Error: kaboom\n Please fix your mistakes.",
        name: "customerStatement",
        tool_call_id: "call_stmt_1",
      },
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_stmt_1", name: "customerStatement", input: {} } },
      {
        type: "tool_result",
        data: { id: "call_stmt_1", name: "customerStatement", output: errorToolMessage },
      },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tr-1",
      toolCallId: "call_stmt_1",
      content: "Error: kaboom\n Please fix your mistakes.",
    })
  })

  test("a live ToolMessage instance shape yields its content, not its fields", async () => {
    // The adapter forwards LangGraph's `on_tool_end` output unserialized: a
    // ToolMessage whose own properties are the fields (no `kwargs` wrapper).
    const liveToolMessage = {
      content: "(no memories found)",
      status: "success",
      name: "recall",
      tool_call_id: "call_recall_1",
      additional_kwargs: {},
      response_metadata: {},
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_recall_1", name: "recall", input: { query: "x" } } },
      {
        type: "tool_result",
        data: { id: "call_recall_1", name: "recall", output: liveToolMessage },
      },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ toolCallId: "call_recall_1", content: "(no memories found)" })
  })

  test("a Command output yields the content of its last ToolMessage", async () => {
    const command = {
      update: {
        todos: [{ content: "a", status: "pending" }],
        messages: [
          {
            content: '{"todos":[{"content":"a","status":"pending"}]}',
            name: "writeTodos",
            tool_call_id: "call_plan_1",
          },
        ],
      },
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_plan_1", name: "savePlan", input: {} } },
      { type: "tool_result", data: { id: "call_plan_1", name: "savePlan", output: command } },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({
      toolCallId: "call_plan_1",
      content: '{"todos":[{"content":"a","status":"pending"}]}',
    })
  })

  test.each([
    ["function", () => undefined],
    ["symbol", Symbol("result")],
  ])("tool result %s output remains string content through AG-UI SSE", async (_, output) => {
    const expected = String(output)
    const events = await collect([
      { type: "tool_result", data: { id: "run-special", name: "special", output } },
      { type: "done" },
    ])
    const result = ToolCallResultEventSchema.parse(
      events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    )

    expect(typeof result.content).toBe("string")
    expect(result.content).toBe(expected)

    // zod output spells optionals as T | undefined; the wire type does not.
    const dataLine = new TextDecoder()
      .decode(encodeAgUiEvent(result as BaseEvent))
      .split("\n")
      .find((line) => line.startsWith("data: "))
    if (dataLine === undefined) throw new Error("SSE frame is missing a data line")
    expect(JSON.parse(dataLine.slice("data: ".length))).toMatchObject({ content: expected })
  })

  test("tool call args JSON-serialize string input", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-string", name: "echo", input: "raw" } },
      { type: "done", data: {} },
    ])
    const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as { delta: string }
    expect(args.delta).toBe('"raw"')
  })

  test("tool call args JSON-serialize null input", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-null", name: "echo", input: null } },
      { type: "done", data: {} },
    ])
    const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as { delta: string }
    expect(args.delta).toBe("null")
  })

  test("tool call args fall back to a string when JSON serialization returns undefined", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-undefined", name: "echo", input: undefined } },
      { type: "tool_call", data: { id: "run-function", name: "echo", input: () => undefined } },
      { type: "done", data: {} },
    ])
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS) as Array<{
      delta: string
    }>
    expect(args.map((e) => e.delta)).toEqual(["{}", "{}"])
  })

  test("interleaved text then tool: open message is flushed before the tool call", async () => {
    const events = await collect([
      { type: "token", data: "thinking" },
      { type: "tool_call", data: { id: "run-x", name: "noop", input: {} } },
      { type: "done", data: {} },
    ])
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("unknown non-token chunks flush an open text message before being ignored", async () => {
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "capability.unknown", data: { arbitrary: true } },
      { type: "token", data: "again" },
      { type: "done", data: {} },
    ])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("plan activity does not flush an open text message", async () => {
    const todos = [{ content: "Search the corpus", status: "in_progress" }] as const
    const events = await collect([
      { type: "token", data: "before" },
      { type: "plan_update", data: { todos } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    const activity = events.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    expect(ActivitySnapshotEventSchema.parse(activity)).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "b4:plan:rn-1",
      activityType: B4_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos },
    })
    expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toMatchObject([
      { messageId: "msg-1", delta: "before" },
      { messageId: "msg-1", delta: "after" },
    ])
  })

  test("malformed recognized plan emits no activity, text flush, or run error", async () => {
    const events = await collect([
      { type: "token", data: "before" },
      { type: "plan_update", data: { todos: [{ content: "invalid", status: "unknown" }] } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)).toEqual([])
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toEqual([])
  })

  test("repeated calls to the same tool get distinct toolCallIds from their upstream ids", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-1", name: "t", input: {} } },
      { type: "tool_call", data: { id: "run-2", name: "t", input: {} } },
      { type: "done", data: {} },
    ])
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START)
    expect(starts.map((e) => (e as { toolCallId: string }).toolCallId)).toEqual(["run-1", "run-2"])
  })

  test("missing-id tool results reuse pending fallback toolCallIds by tool name in FIFO order", async () => {
    const events = await collect([
      { type: "tool_call", data: { name: "greet", input: {} } },
      { type: "tool_call", data: { name: "greet", input: { again: true } } },
      { type: "tool_result", data: { name: "greet", output: "hi" } },
      { type: "tool_result", data: { name: "greet", output: "again" } },
      { type: "done", data: {} },
    ])
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START) as Array<{
      toolCallId: string
    }>
    const results = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT) as Array<{
      toolCallId: string
      messageId: string
    }>
    expect(starts.map((e) => e.toolCallId)).toEqual(["tc-1", "tc-2"])
    expect(results.map((e) => e.toolCallId)).toEqual(["tc-1", "tc-2"])
    expect(results.map((e) => e.messageId)).toEqual(["tr-1", "tr-2"])
  })

  test("interrupt: emits RUN_FINISHED with an interrupt outcome and stops", async () => {
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "done", data: {} }, // must be ignored after interrupt
    ])
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "perm-1",
            reason: "command",
            metadata: { interruptId: "perm-1", kind: "command" },
            responseSchema: PERMISSION_RESPONSE,
          },
        ],
      },
    })
    // exactly one RUN_FINISHED (done after interrupt was ignored)
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1)
  })

  test("consecutive interrupts are accumulated in order before done", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "interrupt", data: { interruptId: "perm-2", kind: "tool" } },
      { type: "done", data: { ignored: true } },
    ])

    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toEqual([
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "perm-1",
              reason: "command",
              metadata: { interruptId: "perm-1", kind: "command" },
              responseSchema: PERMISSION_RESPONSE,
            },
            {
              id: "perm-2",
              reason: "tool",
              metadata: { interruptId: "perm-2", kind: "tool" },
              responseSchema: PERMISSION_RESPONSE,
            },
          ],
        },
      },
    ])
  })

  test("collects interleaved interrupts without leaking post-interrupt events or success", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "subagent.start", data: { callId: "sibling-call" } },
      { type: "token", data: "must not be emitted" },
      { type: "interrupt", data: { interruptId: "perm-2", kind: "tool" } },
      { type: "done", data: { mustNotBecomeResult: true } },
    ])

    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "th-1",
        runId: "rn-1",
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "perm-1",
              reason: "command",
              metadata: { interruptId: "perm-1", kind: "command" },
              responseSchema: PERMISSION_RESPONSE,
            },
            {
              id: "perm-2",
              reason: "tool",
              metadata: { interruptId: "perm-2", kind: "tool" },
              responseSchema: PERMISSION_RESPONSE,
            },
          ],
        },
      },
    ])
    expect(events.at(-1)).not.toHaveProperty("result")
    expect(events.at(-1)).not.toMatchObject({ outcome: { type: "success" } })
  })

  test("natural completion emits accumulated interrupts", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "interrupt", data: { interruptId: "perm-2" } },
    ])

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "perm-1" }, { id: "perm-2" }],
      },
    })
  })

  test("nonterminal chunks after an interrupt are suppressed until the outcome", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "token", data: "must not be emitted" },
      { type: "done" },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({
      outcome: { type: "interrupt", interrupts: [{ id: "perm-1" }] },
    })
  })

  test("an interrupt without a non-empty interruptId terminates with RUN_ERROR", async () => {
    const events = await collect([
      { type: "token", data: "waiting" },
      { type: "interrupt", data: { interruptId: "", kind: "command" } },
      { type: "done" },
    ])

    expect(events.at(-2)).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" })
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "Malformed B4.run interrupt: missing interruptId",
    })
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1)
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(0)
  })

  test("done data is preserved as the successful RUN_FINISHED result", async () => {
    const result = { error: "application value", answer: 42 }
    const events = await collect([{ type: "done", data: result }])

    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      result,
      outcome: { type: "success" },
    })
  })

  test("done without defined data omits the successful result", async () => {
    const events = await collect([{ type: "done" }])
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "th-1",
        runId: "rn-1",
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: { type: "success" },
      },
    ])
  })

  test("stream that ends without a done chunk still flushes and finishes success", async () => {
    const events = await collect([{ type: "token", data: "x" }])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("tool_result with a missing upstream id still emits a result with a synthesized toolCallId", async () => {
    const events = await collect([
      { type: "tool_result", data: { name: "greet", output: "hi" } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as {
      toolCallId: string
      messageId: string
      content: string
    }
    expect(result.content).toBe("hi")
    expect(result.toolCallId).toBe("tc-1") // fallback id
    expect(result.messageId).toBe("tr-1")
  })

  test("upstream throw is emitted as RUN_ERROR, not thrown to the consumer", async () => {
    async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "token", data: "hi" }
      throw new Error("kaboom")
    }
    const out = []
    for await (const ev of toAguiEvents(boom(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "kaboom" })
    // the open text message was flushed before the error
    expect(out.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(true)
  })

  test("an upstream error carrying a string `code` surfaces it on RUN_ERROR", async () => {
    async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "token", data: "hi" }
      throw Object.assign(new Error("rejected"), { code: "middleware_rejected" })
    }
    const out = []
    for await (const ev of toAguiEvents(boom(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "rejected",
      code: "middleware_rejected",
    })
  })

  test("a non-string `code` on an upstream error is not forwarded", async () => {
    async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "token", data: "hi" }
      throw Object.assign(new Error("rejected"), { code: 42 })
    }
    const out = []
    for await (const ev of toAguiEvents(boom(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "rejected" })
  })
  test("a success that leaves client calls parked names them in pendingToolCallIds", async () => {
    const out = []
    for await (const ev of toAguiEvents(toAsync([{ type: "done", data: {} }]), CTX, {
      pendingToolCallIds: () => ["call_a", "call_b"],
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success", pendingToolCallIds: ["call_a", "call_b"] },
    })
  })

  test("pendingToolCallIds may be read asynchronously (the runtime reads them from its record)", async () => {
    const out = []
    for await (const ev of toAguiEvents(toAsync([{ type: "done", data: {} }]), CTX, {
      pendingToolCallIds: async () => ["call_a"],
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success", pendingToolCallIds: ["call_a"] },
    })
  })

  test("a rejecting pendingToolCallIds read ends the run as RUN_ERROR", async () => {
    const out = []
    for await (const ev of toAguiEvents(toAsync([{ type: "done", data: {} }]), CTX, {
      pendingToolCallIds: async () => {
        throw new Error("db down")
      },
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toMatchObject({ type: EventType.RUN_ERROR })
    expect((out.at(-1) as { message: string }).message).toContain("db down")
    expect(out.some((ev) => ev.type === EventType.RUN_FINISHED)).toBe(false)
  })

  test("an ordinary success carries no pendingToolCallIds key at all", async () => {
    const events = await collect([{ type: "done", data: {} }])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "success" } })
    expect((events.at(-1) as { outcome: object }).outcome).not.toHaveProperty("pendingToolCallIds")
  })

  test("a stream that ends without done also names the parked calls", async () => {
    const out = []
    for await (const ev of toAguiEvents(
      toAsync([{ type: "tool_call", data: { id: "call_a", name: "openPanel", input: {} } }]),
      CTX,
      { pendingToolCallIds: () => ["call_a"] },
    )) {
      out.push(ev)
    }
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success", pendingToolCallIds: ["call_a"] },
    })
  })
})

describe("orchestration suppression", () => {
  const TODOS = [{ content: "Search the corpus", status: "in_progress" }] as const
  test("a correlated writeTodos call presents only as a plan activity", async () => {
    const events = await collect([
      {
        type: "tool_call",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", input: { todos: TODOS } },
      },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an uncorrelated writeTodos call keeps its generic frames in source order", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("ordinary tools are never suppressed and keep their order around a suppressed one", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "tool_call",
        data: { id: "call_searchCorpus_0_2", name: "searchCorpus", input: { q: "x" } },
      },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      {
        type: "tool_result",
        data: { id: "call_searchCorpus_0_2", name: "searchCorpus", output: "hit" },
      },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    // The ordinary call's frames reached the mapper before the plan activity,
    // so they stay ahead of it: suppression never reorders the stream.
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    const start = events.find((event) => event.type === EventType.TOOL_CALL_START)
    expect(start).toMatchObject({ toolCallName: "searchCorpus" })
  })

  test("text framing survives a deferred orchestration call", async () => {
    const events = await collect([
      { type: "token", data: "before" },
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an ID-less writeTodos call is never suppressed", async () => {
    const events = await collect([
      { type: "tool_call", data: { name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS } },
      { type: "tool_result", data: { name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an incomplete stream flushes held frames before RUN_FINISHED", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an interrupt drops the frames of the call it belongs to", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_2", name: "writeTodos", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "tool", toolCallId: "call_writeTodos_0_2" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  })

  test("an interrupt drops the frames of the call it belongs to via the envelope's callId", async () => {
    // B4.run's real interrupt envelopes (permission-gate.ts, agent-adapter.ts's
    // projectInterruptValue) carry `callId`, not `toolCallId` — this proves
    // the mapper bridges that vocabulary end to end into the ledger.
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_2", name: "writeTodos", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "tool", callId: "call_writeTodos_0_2" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  })

  test("an interrupt flushes an unrelated held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "command", toolCallId: "call_runBash_0_9" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.find((event) => event.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: "call_writeTodos_0_1",
    })
  })

  test("an interrupt with no toolCallId flushes every held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { interruptId: "int-1", kind: "memory" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.find((event) => event.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: "call_task_0_2",
    })
  })

  test("a malformed interrupt flushes held frames before RUN_ERROR", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { kind: "tool" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })

  test("an upstream error flushes held frames before RUN_ERROR", async () => {
    async function* failing(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } }
      throw new Error("boom")
    }

    const events = []
    for await (const event of toAguiEvents(failing(), CTX, {
      idFactory: createCounterIdFactory(),
    })) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })
})

describe("streamed tool-call arguments", () => {
  const args = { city: "Paris", days: 3 }
  const full = JSON.stringify(args)
  const delta = (delta: string) => ({
    type: "tool_call_args",
    data: { id: "call_1", name: "weather", delta },
  })

  function argFrames(events: Awaited<ReturnType<typeof collect>>) {
    return events.filter((event) => event.type === EventType.TOOL_CALL_ARGS)
  }

  test("deltas open the call, stream as they arrive, and the announce closes it", async () => {
    const events = await collect([
      delta('{"city":'),
      delta('"Paris",'),
      delta('"days":3}'),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "tool_result", data: { id: "call_1", name: "weather", output: "sunny" } },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "th-1",
        runId: "rn-1",
        protocolVersion: PROTOCOL_VERSION,
      },
      { type: EventType.TOOL_CALL_START, toolCallId: "call_1", toolCallName: "weather" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: '{"city":' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: '"Paris",' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: '"days":3}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr-1",
        toolCallId: "call_1",
        content: "sunny",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        result: {},
        outcome: { type: "success" },
      },
    ])
    expect(
      argFrames(events)
        .map((event) => event.delta)
        .join(""),
    ).toBe(full)
  })

  test("the announce emits whatever the deltas did not cover as one last delta", async () => {
    const events = await collect([
      delta('{"city":"Paris"'),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "done", data: {} },
    ])
    expect(argFrames(events).map((event) => event.delta)).toEqual(['{"city":"Paris"', ',"days":3}'])
  })

  test("an announce whose payload does not extend the streamed text adds nothing", async () => {
    const events = await collect([
      delta('{"days":3,"city":"Paris"}'),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "done", data: {} },
    ])
    expect(argFrames(events).map((event) => event.delta)).toEqual(['{"days":3,"city":"Paris"}'])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("two interleaved streamed calls keep separate frames under their own ids", async () => {
    const other = (d: string) => ({
      type: "tool_call_args",
      data: { id: "call_2", name: "b", delta: d },
    })
    const events = await collect([
      delta('{"city":'),
      other('{"b":'),
      delta('"Paris","days":3}'),
      other("2}"),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "tool_call", data: { id: "call_2", name: "b", input: { b: 2 } } },
      { type: "done", data: {} },
    ])
    expect(
      events.map((event) => [event.type, "toolCallId" in event ? event.toolCallId : ""]),
    ).toEqual([
      [EventType.RUN_STARTED, ""],
      [EventType.TOOL_CALL_START, "call_1"],
      [EventType.TOOL_CALL_ARGS, "call_1"],
      [EventType.TOOL_CALL_START, "call_2"],
      [EventType.TOOL_CALL_ARGS, "call_2"],
      [EventType.TOOL_CALL_ARGS, "call_1"],
      [EventType.TOOL_CALL_ARGS, "call_2"],
      [EventType.TOOL_CALL_END, "call_1"],
      [EventType.TOOL_CALL_END, "call_2"],
      [EventType.RUN_FINISHED, ""],
    ])
  })

  test("the first delta flushes an open anonymous text message, as an announce does", async () => {
    const events = await collect([
      { type: "token", data: "Looking" },
      delta("{}"),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: {} } },
      { type: "done", data: {} },
    ])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an empty delta opens the call without an args frame", async () => {
    const events = await collect([
      delta(""),
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "done", data: {} },
    ])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    expect(argFrames(events).map((event) => event.delta)).toEqual([full])
  })

  test("a malformed args chunk is ignored", async () => {
    const events = await collect([
      { type: "tool_call_args", data: { name: "weather", delta: "{}" } },
      { type: "tool_call_args", data: { id: "call_1", delta: "{}" } },
      { type: "tool_call_args", data: { id: "call_1", name: "weather" } },
      { type: "done", data: {} },
    ])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
  })

  test.each([
    ["done", { type: "done", data: {} }, EventType.RUN_FINISHED],
    ["interrupt", { type: "interrupt", data: { interruptId: "i-1" } }, EventType.RUN_FINISHED],
  ] as const)("a still-open streamed call is ended before %s", async (_label, terminal, last) => {
    const events = await collect([delta('{"city":'), terminal])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      last,
    ])
  })

  test("a still-open streamed call is ended when the stream is exhausted", async () => {
    const events = await collect([delta('{"city":')])
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("a still-open streamed call is ended before an upstream error", async () => {
    async function* failing(): AsyncGenerator<B4AgentStreamChunk> {
      yield delta('{"city":')
      throw new Error("boom")
    }
    const events = []
    for await (const event of toAguiEvents(failing(), CTX, {
      idFactory: createCounterIdFactory(),
    })) {
      events.push(event)
    }
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })

  test("an abort the consumer reports as a cancel ends the run with the cancelled outcome", async () => {
    async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "token", data: "partial" }
      throw new Error("AG-UI request aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(aborted(), CTX, {
      idFactory: createCounterIdFactory(),
      cancelled: () => true,
    })) {
      out.push(ev)
    }
    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(out.at(-1)).toMatchObject({ outcome: { type: "cancelled" } })
    expect(out.at(-1)).not.toHaveProperty("result")
  })

  test("an abort the consumer does not report as a cancel is still RUN_ERROR", async () => {
    // biome-ignore lint/correctness/useYield: the upstream throws before producing a chunk
    async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
      throw new Error("AG-UI request aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(aborted(), CTX, { cancelled: () => false })) out.push(ev)
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "AG-UI request aborted",
    })
  })
})

describe("1.0 null discipline", () => {
  /** Top-level keys of an event, and of each interrupt and outcome it carries, are never `null`. */
  function assertNoNullField(label: string, value: Record<string, unknown>): void {
    for (const [key, field] of Object.entries(value)) {
      if (key === "metadata" || key === "result") continue // application data
      if (key === "content" && label.startsWith("tool_call")) {
        expect(typeof field, `${label}.content`).toBe("string")
      }
      expect(field, `${label}.${key}`).not.toBeNull()
      if (key === "outcome" && field && typeof field === "object") {
        assertNoNullField(`${label}.outcome`, field as Record<string, unknown>)
        const interrupts = (field as { interrupts?: unknown }).interrupts
        if (Array.isArray(interrupts)) {
          for (const [index, interrupt] of interrupts.entries()) {
            assertNoNullField(`${label}.outcome.interrupts[${index}]`, interrupt)
          }
        }
      }
    }
  }

  test("every event kind B4.run emits", async () => {
    const streams: B4AgentStreamChunk[][] = [
      [
        { type: "token", data: "hi" },
        { type: "done", data: null },
      ],
      [
        { type: "tool_call", data: { id: "c1", name: "search", input: { q: 1 } } },
        { type: "tool_result", data: { id: "c1", name: "search", output: null } },
        { type: "done" },
      ],
      [
        {
          type: "interrupt",
          data: { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "g" },
        },
      ],
      [
        {
          type: "plan_update",
          data: { tool_call_id: "p1", todos: [{ content: "a", status: "pending" }] },
        },
        { type: "subagent.start", data: CHILD },
        { type: "subagent.end", data: { ...CHILD, final_message: "x" } },
        { type: "done", data: undefined },
      ],
    ]
    for (const stream of streams) {
      const events = await collect(stream)
      for (const [index, event] of events.entries()) {
        assertNoNullField(`${stream[0]?.type}[${index}]`, event as Record<string, unknown>)
      }
    }
    // The throwing path.
    // biome-ignore lint/correctness/useYield: a stream that fails before its first chunk
    async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
      throw Object.assign(new Error("x"), { code: "after_rejected" })
    }
    for await (const event of toAguiEvents(boom(), CTX)) {
      assertNoNullField("error", event as Record<string, unknown>)
    }
  })

  test("a done with a null payload carries no result key", async () => {
    const events = await collect([{ type: "done", data: null }])
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(events.at(-1)).not.toHaveProperty("result")
  })
})

describe("usage", () => {
  const CALL = {
    provider: "openai",
    model: "gpt-5-mini",
    usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
  const ONE = {
    provider: "openai",
    model: "gpt-5-mini",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  }
  const TWO = { ...ONE, inputTokens: 20, outputTokens: 10, totalTokens: 30 }

  test("RUN_FINISHED success aggregates root and child calls", async () => {
    const out = await collect([
      { type: "usage", data: CALL },
      { type: "subagent.usage", data: { ...CHILD, ...CALL } },
      { type: "done", data: { ok: true } },
    ])
    expect(out.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: CTX.threadId,
      runId: CTX.runId,
      result: { ok: true },
      outcome: { type: "success" },
      usage: [TWO],
    })
  })

  test("the key is absent, never [], when no call reported usage", async () => {
    const out = await collect([{ type: "token", data: "hi" }, { type: "done" }])
    expect(out.at(-1)).not.toHaveProperty("usage")
  })

  test("a malformed usage payload is ignored", async () => {
    const out = await collect([
      { type: "usage", data: { provider: "openai" } },
      { type: "usage", data: { usage_metadata: { nothing: true } } },
      { type: "done" },
    ])
    expect(out.at(-1)).not.toHaveProperty("usage")
  })

  test("RUN_FINISHED interrupt carries usage", async () => {
    const out = await collect([
      { type: "usage", data: CALL },
      { type: "interrupt", data: { interruptId: "i-1", kind: "tool", callId: "tc-9" } },
      { type: "done" },
    ])
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt" },
      usage: [ONE],
    })
  })

  test("RUN_FINISHED cancelled carries the usage accrued before the stop", async () => {
    async function* stream(): AsyncIterable<B4AgentStreamChunk> {
      yield { type: "usage", data: CALL }
      throw new Error("aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(stream(), CTX, {
      idFactory: createCounterIdFactory(),
      cancelled: () => true,
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: CTX.threadId,
      runId: CTX.runId,
      outcome: { type: "cancelled" },
      usage: [ONE],
    })
  })

  test("RUN_ERROR carries the usage accrued before the failure", async () => {
    async function* stream(): AsyncIterable<B4AgentStreamChunk> {
      yield { type: "usage", data: CALL }
      throw new Error("boom")
    }
    const out = []
    for await (const ev of toAguiEvents(stream(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "boom", usage: [ONE] })
  })

  test("a stream that ends without done still reports usage", async () => {
    const out = await collect([{ type: "usage", data: CALL }])
    expect(out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, usage: [ONE] })
  })

  test("usage chunks never open or close a text message", async () => {
    const out = await collect([
      { type: "token", data: "a" },
      { type: "usage", data: CALL },
      { type: "token", data: "b" },
      { type: "done" },
    ])
    expect(out.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1)
  })
})

describe("reasoning", () => {
  test("an identified invocation: span and message open on the first delta, close at message_end, interleaving with text", async () => {
    const out = await collect([
      { type: "reasoning", data: "think ", messageId: "m1" },
      { type: "token", data: "Hi", messageId: "m1" },
      { type: "reasoning", data: "more", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "done" },
    ])
    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(out[1]).toEqual({ type: EventType.REASONING_START, messageId: "rspan-1" })
    expect(out[2]).toEqual({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "rsn-1",
      role: "reasoning",
    })
    expect(out[3]).toEqual({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "rsn-1",
      delta: "think ",
    })
    expect(out[4]).toMatchObject({ type: EventType.TEXT_MESSAGE_START, messageId: "msg-1" })
    expect(out[7]).toEqual({ type: EventType.REASONING_MESSAGE_END, messageId: "rsn-1" })
    expect(out[8]).toEqual({ type: EventType.REASONING_END, messageId: "rspan-1" })
  })

  test("two invocations get two spans and two reasoning messages", async () => {
    const out = await collect([
      { type: "reasoning", data: "a", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "reasoning", data: "b", messageId: "m2" },
      { type: "message_end", data: { messageId: "m2" } },
      { type: "done" },
    ])
    expect(
      out.filter((e) => e.type === EventType.REASONING_MESSAGE_START).map((e) => e.messageId),
    ).toEqual(["rsn-1", "rsn-2"])
    expect(out.filter((e) => e.type === EventType.REASONING_START).map((e) => e.messageId)).toEqual(
      ["rspan-1", "rspan-2"],
    )
  })

  test("an anonymous reasoning delta closes at the next tool boundary", async () => {
    const out = await collect([
      { type: "reasoning", data: "plan" },
      { type: "tool_call", data: { id: "tc-9", name: "search", input: {} } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(
      kinds.indexOf(EventType.TOOL_CALL_START),
    )
    expect(kinds.filter((k) => k === EventType.REASONING_START)).toHaveLength(1)
  })

  test("reasoning still open at done, interrupt and stream end is closed before the terminal", async () => {
    const tails: B4AgentStreamChunk[][] = [
      [{ type: "done" }],
      [
        { type: "interrupt", data: { interruptId: "i-1", kind: "tool", callId: "tc-1" } },
        { type: "done" },
      ],
      [],
    ]
    for (const tail of tails) {
      const out = await collect([{ type: "reasoning", data: "x", messageId: "m1" }, ...tail])
      const kinds = out.map((e) => e.type)
      expect(kinds).toContain(EventType.REASONING_MESSAGE_END)
      expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(kinds.length - 1)
      expect(kinds.at(-1)).toBe(EventType.RUN_FINISHED)
    }
  })

  test("reasoning still open at a cancel or an error is closed before the terminal", async () => {
    for (const cancelled of [true, false]) {
      async function* stream(): AsyncIterable<B4AgentStreamChunk> {
        yield { type: "reasoning", data: "x", messageId: "m1" }
        throw new Error("stop")
      }
      const out = []
      for await (const ev of toAguiEvents(stream(), CTX, {
        idFactory: createCounterIdFactory(),
        cancelled: () => cancelled,
      })) {
        out.push(ev)
      }
      expect(out.map((e) => e.type).slice(-3)).toEqual([
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        cancelled ? EventType.RUN_FINISHED : EventType.RUN_ERROR,
      ])
    }
  })

  test("an empty reasoning delta emits nothing", async () => {
    const out = await collect([{ type: "reasoning", data: "", messageId: "m1" }, { type: "done" }])
    expect(out.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
  })
})

describe("subagents", () => {
  const START = {
    type: "subagent.start",
    data: { ...CHILD, description: "Finds sources" },
  } as const
  const token = (data: string, messageId = "cm1") =>
    ({ type: "subagent.token", data: { ...CHILD, data, messageId } }) as const

  test("start → SUBAGENT_STARTED hanging off the task call; end → FINISHED with the result; task frames flow", async () => {
    const out = await collect([
      {
        type: "tool_call",
        data: { id: CHILD.call_id, name: "task", input: { subagent: "researcher" } },
      },
      START,
      token("Reading"),
      { type: "subagent.message_end", data: { ...CHILD, messageId: "cm1" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "found it" } },
      { type: "tool_result", data: { id: CHILD.call_id, name: "task", output: "found it" } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    // The task call is an ordinary tool call again: its frames are on the wire.
    expect(kinds.slice(1, 4)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ])
    expect(out[4]).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: CHILD.call_id,
      name: "researcher",
      description: "Finds sources",
      parentToolCallId: CHILD.call_id,
    })
    expect(out[5]).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
      subagentRunId: CHILD.call_id,
    })
    expect(out[6]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "Reading",
      subagentRunId: CHILD.call_id,
    })
    expect(out[7]).toEqual({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
      subagentRunId: CHILD.call_id,
    })
    expect(out[8]).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      result: "found it",
      outcome: { type: "success" },
    })
    expect(out[9]).toMatchObject({ type: EventType.TOOL_CALL_RESULT, toolCallId: CHILD.call_id })
    expect(out[9]).not.toHaveProperty("subagentRunId")
    expect(kinds).not.toContain(EventType.ACTIVITY_SNAPSHOT)
  })

  test("a failed child is SUBAGENT_ERROR", async () => {
    const out = await collect([
      START,
      { type: "subagent.end", data: { ...CHILD, error: "boom" } },
      { type: "done" },
    ])
    expect(out[1]).toMatchObject({ type: EventType.SUBAGENT_STARTED })
    expect(out[2]).toEqual({
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: CHILD.call_id,
      message: "boom",
    })
  })

  test("the child's tool calls, reasoning, usage and plan are attributed; the plan has its own id", async () => {
    const out = await collect([
      START,
      { type: "subagent.reasoning", data: { ...CHILD, data: "plan", messageId: "cm1" } },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "ct1", name: "readDoc", input: { p: "a" } },
      },
      {
        type: "subagent.tool_result",
        data: { ...CHILD, id: "ct1", name: "readDoc", output: "text" },
      },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, todos: [{ content: "read", status: "completed" }] },
      },
      {
        type: "subagent.usage",
        data: { ...CHILD, usage_metadata: { input_tokens: 1, output_tokens: 1 } },
      },
      { type: "subagent.end", data: { ...CHILD, final_message: "ok" } },
      { type: "done" },
    ])
    for (const e of out) {
      if (e.type === EventType.RUN_STARTED || e.type === EventType.RUN_FINISHED) continue
      expect(e).toHaveProperty("subagentRunId", CHILD.call_id)
    }
    expect(out.find((e) => e.type === EventType.ACTIVITY_SNAPSHOT)).toMatchObject({
      messageId: `b4:plan:${CHILD.call_id}`,
      activityType: B4_PLAN_ACTIVITY_TYPE,
      replace: true,
    })
    expect(out.find((e) => e.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: "ct1",
      toolCallName: "readDoc",
    })
    const kinds = out.map((e) => e.type)
    // Open reasoning closes before the child finishes.
    expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(
      kinds.indexOf(EventType.SUBAGENT_FINISHED),
    )
    expect(out.at(-1)).toMatchObject({ usage: [{ inputTokens: 1, outputTokens: 1 }] })
  })

  test("a nested child names its parent invocation", async () => {
    const GRAND = { call_id: "c2", subagent: "reader", route_id: "/r#reader", depth: 2 }
    const out = await collect([
      START,
      { type: "subagent.start", data: { ...GRAND, parent_call_id: CHILD.call_id } },
      { type: "subagent.end", data: { ...GRAND, final_message: "x" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "y" } },
      { type: "done" },
    ])
    expect(out[2]).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "c2",
      name: "reader",
      parentToolCallId: "c2",
      parentSubagentRunId: CHILD.call_id,
    })
    expect(out.map((e) => e.type).slice(3)).toEqual([
      EventType.SUBAGENT_FINISHED,
      EventType.SUBAGENT_FINISHED,
      EventType.RUN_FINISHED,
    ])
  })

  test("a child interrupt suspends the child, tags the interrupt, and text closes first", async () => {
    const out = await collect([
      START,
      token("asking"),
      {
        type: "interrupt",
        data: {
          interruptId: "i1",
          kind: "tool",
          callId: CHILD.call_id,
          toolCallId: "child-call-9",
        },
      },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.slice(-2)).toEqual([EventType.SUBAGENT_FINISHED, EventType.RUN_FINISHED])
    expect(out.at(-2)).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      outcome: { type: "suspended", interruptIds: ["i1"] },
    })
    expect(out.at(-1)).toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "i1", toolCallId: "child-call-9", subagentRunId: CHILD.call_id }],
      },
    })
    expect(kinds.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      kinds.indexOf(EventType.SUBAGENT_FINISHED),
    )
  })

  test("a root gate's interrupt names its call and no subagent", async () => {
    const out = await collect([
      START,
      {
        type: "interrupt",
        data: { interruptId: "r2", kind: "command", toolCallId: "call-root-1" },
      },
      { type: "done" },
    ])
    expect(out.at(-2)).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      outcome: { type: "suspended" },
    })
    const interrupt = (out.at(-1) as { outcome: { interrupts: Record<string, unknown>[] } }).outcome
      .interrupts[0]
    expect(interrupt).toMatchObject({ id: "r2", toolCallId: "call-root-1" })
    expect(interrupt).not.toHaveProperty("subagentRunId")
  })

  test("a parent suspended only because its child interrupted carries no interruptIds; deepest closes first", async () => {
    const GRAND = { call_id: "c2", subagent: "reader", route_id: "/r#reader", depth: 2 }
    const out = await collect([
      START,
      { type: "subagent.start", data: { ...GRAND, parent_call_id: CHILD.call_id } },
      { type: "interrupt", data: { interruptId: "i1", kind: "tool", callId: "c2" } },
      { type: "done" },
    ])
    const finished = out.filter((e) => e.type === EventType.SUBAGENT_FINISHED)
    expect(finished.map((e) => e.subagentRunId)).toEqual(["c2", CHILD.call_id])
    expect(finished[0]).toMatchObject({ outcome: { type: "suspended", interruptIds: ["i1"] } })
    expect(finished[1]).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      outcome: { type: "suspended" },
    })
    // A root interrupt is never attributed.
    const root = await collect([
      START,
      { type: "interrupt", data: { interruptId: "r1", kind: "tool", callId: "some-root-tool" } },
      { type: "done" },
    ])
    expect(root.at(-1)).toMatchObject({ outcome: { interrupts: [{ id: "r1" }] } })
    expect(
      (root.at(-1) as { outcome: { interrupts: unknown[] } }).outcome.interrupts[0],
    ).not.toHaveProperty("subagentRunId")
  })

  test("open children at done or stream end are closed with SUBAGENT_ERROR; a cancel too; RUN_ERROR abandons them", async () => {
    for (const tail of [[{ type: "done" }], []] as B4AgentStreamChunk[][]) {
      const out = await collect([START, token("x"), ...tail])
      expect(out.at(-2)).toEqual({
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: CHILD.call_id,
        message: "The run ended before the subagent finished.",
        code: "unterminated",
      })
      expect(out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    }
    for (const cancelled of [true, false]) {
      async function* failing(): AsyncIterable<B4AgentStreamChunk> {
        yield START
        throw new Error("stop")
      }
      const out = []
      for await (const ev of toAguiEvents(failing(), CTX, {
        idFactory: createCounterIdFactory(),
        cancelled: () => cancelled,
      })) {
        out.push(ev)
      }
      if (cancelled) {
        expect(out.at(-2)).toEqual({
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: CHILD.call_id,
          message: "The run was cancelled.",
          code: "cancelled",
        })
        expect(out.at(-1)).toMatchObject({ outcome: { type: "cancelled" } })
      } else {
        expect(out.map((e) => e.type)).not.toContain(EventType.SUBAGENT_ERROR)
        expect(out.at(-1)?.type).toBe(EventType.RUN_ERROR)
      }
    }
  })

  test("a chunk for an unannounced child, or a re-announce of an open child, is dropped", async () => {
    const out = await collect([
      token("orphan"),
      START,
      START,
      { type: "subagent.end", data: { ...CHILD, final_message: "ok" } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.filter((k) => k === EventType.SUBAGENT_STARTED)).toHaveLength(1)
    expect(kinds).not.toContain(EventType.TEXT_MESSAGE_START)
    expect(kinds).toEqual([
      EventType.RUN_STARTED,
      EventType.SUBAGENT_STARTED,
      EventType.SUBAGENT_FINISHED,
      EventType.RUN_FINISHED,
    ])
  })
})

describe("toolResultView", () => {
  const live = (extra: Record<string, unknown>) => ({ tool_call_id: "c1", ...extra })

  test("a live error ToolMessage is failed", () => {
    expect(toolResultView(live({ content: "boom", status: "error" }))).toEqual({
      content: "boom",
      failed: true,
    })
  })

  test("a serialized error ToolMessage is failed", () => {
    expect(toolResultView({ kwargs: live({ content: "boom", status: "error" }) })).toEqual({
      content: "boom",
      failed: true,
    })
  })

  test("a success ToolMessage is not failed", () => {
    expect(toolResultView(live({ content: "ok", status: "success" }))).toEqual({
      content: "ok",
      failed: false,
    })
  })

  test("bare values are serialized and not failed", () => {
    expect(toolResultView("plain")).toEqual({ content: "plain", failed: false })
    expect(toolResultView({ a: 1 })).toEqual({ content: '{"a":1}', failed: false })
  })

  test("a Command scan skips trailing non-ToolMessage entries", () => {
    const command = {
      update: { messages: [live({ content: "tool text" }), { content: "thinking", type: "ai" }] },
    }
    expect(toolResultView(command)).toEqual({ content: "tool text", failed: false })
  })

  test("a non-object kwargs falls back to the top-level fields", () => {
    expect(toolResultView({ kwargs: 3, tool_call_id: "c1", content: "top" })).toEqual({
      content: "top",
      failed: false,
    })
  })

  test("array content parts flatten to their text", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "image_url", image_url: "x" },
      { type: "text", text: "b" },
    ]
    expect(toolResultView(live({ content })).content).toBe("a b")
  })

  test("a hostile getter does not escape the stream", async () => {
    const hostile = {
      get tool_call_id(): string {
        throw new Error("hostile")
      },
    }
    const events = await collect([
      { type: "tool_call", data: { id: "h1", name: "t", input: {} } },
      { type: "tool_result", data: { id: "h1", name: "t", output: hostile } },
      { type: "done", data: {} },
    ])
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true)
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(typeof (result as { content: unknown }).content).toBe("string")
  })
})
