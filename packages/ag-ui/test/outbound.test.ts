import { type BaseEvent, EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { ActivitySnapshotEventSchema, ToolCallResultEventSchema } from "@ag-ui/core/schemas"
import { describe, expect, test } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE, B4_SUBAGENT_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { toAguiEvents } from "../src/outbound.js"
import { encodeAgUiEvent } from "../src/sse.js"
import type { B4AgentStreamChunk } from "../src/types.js"

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
    // What @b4run/langchain emits for a thrown tool: the serialized error
    // ToolMessage the model receives, keyed by the model's tool-call id.
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
      content: JSON.stringify(errorToolMessage),
    })
    expect(JSON.parse((result as { content: string }).content).kwargs.status).toBe("error")
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

  test("subagent activity exposes only allowlisted progress and never child content", async () => {
    const childTodos = [{ content: "Read the source", status: "in_progress" }] as const
    const events = await collect([
      { type: "token", data: "root-before" },
      { type: "subagent.start", data: CHILD },
      { type: "subagent.plan_update", data: { ...CHILD, todos: childTodos } },
      {
        type: "subagent.tool_call",
        data: {
          ...CHILD,
          id: "child-tool-1",
          name: "readDoc",
          input: "secret-input",
        },
      },
      {
        type: "subagent.tool_result",
        data: { ...CHILD, id: "child-tool-1", output: "secret-output" },
      },
      { type: "subagent.token", data: { ...CHILD, content: "secret-child-prose" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "secret-final" } },
      { type: "token", data: "root-after" },
      { type: "done" },
    ])

    const activities = events
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    expect(activities).toEqual([
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:subagent:call-1",
        activityType: B4_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          tools: [],
          totalToolCount: 0,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:subagent:call-1",
        activityType: B4_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [],
          totalToolCount: 0,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:subagent:call-1",
        activityType: B4_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "running" }],
          totalToolCount: 1,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:subagent:call-1",
        activityType: B4_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "completed" }],
          totalToolCount: 1,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:subagent:call-1",
        activityType: B4_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "completed",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "completed" }],
          totalToolCount: 1,
        },
      },
    ])

    const serializedContent = JSON.stringify(activities.map((activity) => activity.content))
    for (const secret of [
      "secret-input",
      "secret-output",
      "secret-child-prose",
      "secret-final",
      CHILD.call_id,
      CHILD.route_id,
      "child-tool-1",
    ]) {
      expect(serializedContent).not.toContain(secret)
    }
    const rootText = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join("")
    expect(rootText).toBe("root-beforeroot-after")
    expect(rootText).not.toMatch(/secret-input|secret-output|secret-child-prose|secret-final/)
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
          { id: "perm-1", reason: "command", metadata: { interruptId: "perm-1", kind: "command" } },
        ],
      },
    })
    // exactly one RUN_FINISHED (done after interrupt was ignored)
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1)
  })

  test("delegation approval interrupt before subagent start emits no activity", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "delegate-1", kind: "tool" } },
      { type: "subagent.start", data: CHILD },
      { type: "done" },
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
              id: "delegate-1",
              reason: "tool",
              metadata: { interruptId: "delegate-1", kind: "tool" },
            },
          ],
        },
      },
    ])
  })

  test("child-owned interrupt preserves one running activity and suppresses later child events", async () => {
    const events = await collect([
      { type: "subagent.start", data: CHILD },
      { type: "interrupt", data: { interruptId: "child-approval", kind: "command" } },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, todos: [{ content: "private-late-plan", status: "pending" }] },
      },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "late-tool", name: "lateTool", input: "private-late-input" },
      },
      { type: "subagent.end", data: { ...CHILD, final_message: "private-late-final" } },
      { type: "done" },
    ])

    const activities = events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    expect(activities).toHaveLength(1)
    expect(ActivitySnapshotEventSchema.parse(activities[0])).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "b4:subagent:call-1",
      activityType: B4_SUBAGENT_ACTIVITY_TYPE,
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
    })
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "child-approval",
            reason: "command",
            metadata: { interruptId: "child-approval", kind: "command" },
          },
        ],
      },
    })
    expect(JSON.stringify(events)).not.toMatch(
      /private-late-plan|private-late-input|private-late-final/,
    )
  })

  test("resume replaces a subagent activity with fresh request-local state", async () => {
    const firstRequest = await collect([
      { type: "subagent.start", data: CHILD },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, todos: [{ content: "Old plan", status: "in_progress" }] },
      },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "old-tool", name: "oldTool", input: "old-input" },
      },
      { type: "interrupt", data: { interruptId: "parked-child", kind: "command" } },
      { type: "done" },
    ])
    const secondRequest = await collect([
      { type: "subagent.start", data: CHILD },
      { type: "subagent.end", data: { ...CHILD, final_message: "private-final" } },
      { type: "done" },
    ])

    const firstActivities = firstRequest
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    const secondActivities = secondRequest
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    expect(firstActivities).toHaveLength(3)
    expect(secondActivities).toHaveLength(2)
    expect([...firstActivities, ...secondActivities].map((event) => event.messageId)).toEqual([
      "b4:subagent:call-1",
      "b4:subagent:call-1",
      "b4:subagent:call-1",
      "b4:subagent:call-1",
      "b4:subagent:call-1",
    ])
    expect(secondActivities.map((event) => event.content)).toEqual([
      {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
      {
        name: "researcher",
        depth: 1,
        status: "completed",
        tools: [],
        totalToolCount: 0,
      },
    ])
    expect(JSON.stringify(secondActivities.map((event) => event.content))).not.toMatch(
      /Old plan|oldTool|old-input|private-final/,
    )
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
            },
            {
              id: "perm-2",
              reason: "tool",
              metadata: { interruptId: "perm-2", kind: "tool" },
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
            },
            {
              id: "perm-2",
              reason: "tool",
              metadata: { interruptId: "perm-2", kind: "tool" },
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
  const ORCHESTRATION_CHILD = {
    call_id: "call_task_0_2",
    subagent: "researcher",
    route_id: "/researcher",
    depth: 1,
  } as const

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

  test("a dropped-parts CUSTOM queues behind a held writeTodos call, in source order", async () => {
    const dropped = { provider: "openai", model: "gpt-5-mini", parts: [] }
    const custom = { type: EventType.CUSTOM, name: "b4.content_parts_dropped", value: dropped }

    // Correlated: the call is suppressed in favour of its activity. The CUSTOM
    // waited while the call was held, then drains in source order — it
    // arrived before plan_update, so it precedes the activity.
    const correlated = await collect([
      {
        type: "tool_call",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", input: { todos: TODOS } },
      },
      { type: "content_parts_dropped", data: dropped },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])
    expect(correlated.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
    expect(correlated[1]).toEqual(custom)

    // Uncorrelated: the held call fails open to its generic frames, and the
    // CUSTOM queued behind it never overtakes them.
    const uncorrelated = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "content_parts_dropped", data: dropped },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])
    expect(uncorrelated.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    expect(uncorrelated[4]).toEqual(custom)
  })

  test("a correlated task call presents only as a subagent activity", async () => {
    const events = await collect([
      {
        type: "tool_call",
        data: { id: "call_task_0_2", name: "task", input: { subagent: "researcher" } },
      },
      { type: "subagent.start", data: ORCHESTRATION_CHILD },
      { type: "subagent.end", data: ORCHESTRATION_CHILD },
      { type: "tool_result", data: { id: "call_task_0_2", name: "task", output: "done" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
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
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "tool", toolCallId: "call_task_0_2" },
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
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "subagent", callId: "call_task_0_2" },
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

const PNG_PART = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }

describe("content parts outbound", () => {
  test("a tool result that is a part array becomes ContentPart[] content", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const events = await collect([
      { type: "tool_call", data: { id: "c1", name: "render", input: {} } },
      { type: "tool_result", data: { id: "c1", name: "render", output: parts } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT)
    expect(result).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tr-1",
      toolCallId: "c1",
      content: parts,
    })
    expect(() => ToolCallResultEventSchema.parse(result)).not.toThrow()
  })

  test("a ToolMessage that kept its parts in kwargs emits them, not the model-visible blocks", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const toolMessage = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: [{ type: "text", text: "chart" }],
        tool_call_id: "c1",
        additional_kwargs: { b4_content_parts: parts },
      },
    }
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: toolMessage } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as { content: unknown }
    expect(result.content).toEqual(parts)
  })

  test("a live ToolMessage's additional_kwargs parts win over its content", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const liveToolMessage = {
      content: "chart",
      tool_call_id: "c1",
      additional_kwargs: { b4_content_parts: parts },
    }
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: liveToolMessage } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as { content: unknown }
    expect(result.content).toEqual(parts)
  })

  test("a live Command wrapping a ToolMessage emits the kept parts, not the stringified Command", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    // The live shape `on_tool_end` hands over when a tool returns `{ result, state }`.
    const command = {
      lg_name: "Command",
      lc_direct_tool_output: true,
      update: {
        messages: [
          {
            lc_serializable: true,
            content: [{ type: "text", text: "chart" }],
            additional_kwargs: { b4_content_parts: parts },
            response_metadata: { output_version: "v1" },
            type: "tool",
            tool_call_id: "c1",
          },
        ],
        notes: ["kept"],
      },
      goto: [],
    }
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: command } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ content: parts })
    expect(() => ToolCallResultEventSchema.parse(result)).not.toThrow()
  })

  test("a serialized Command prefers the ToolMessage whose tool_call_id matches the result", async () => {
    const other = [{ type: "text", text: "other" }]
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const serializedToolMessage = (toolCallId: string, kept: unknown) => ({
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: [{ type: "text", text: "x" }],
        tool_call_id: toolCallId,
        additional_kwargs: { b4_content_parts: kept },
        response_metadata: { output_version: "v1" },
      },
    })
    // Exactly what JSON.stringify makes of a @langchain/langgraph Command.
    const command = JSON.parse(
      JSON.stringify({
        lg_name: "Command",
        update: {
          messages: [
            {
              lc: 1,
              type: "constructor",
              id: ["langchain_core", "messages", "AIMessage"],
              kwargs: { content: "hi" },
            },
            serializedToolMessage("someone-else", other),
            serializedToolMessage("c1", parts),
          ],
        },
        goto: [],
      }),
    )
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: command } },
      { type: "tool_result", data: { id: "c9", name: "render", output: command } },
      { type: "done", data: {} },
    ])
    const contents = events
      .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
      .map((e) => (e as { content: unknown }).content)
    // A match wins; with no match, the first ToolMessage carrying parts.
    expect(contents).toEqual([parts, other])
  })

  test("a Command with no kept parts stays JSON text", async () => {
    const command = { lg_name: "Command", update: { messages: [], notes: [] }, goto: [] }
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: command } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as { content: unknown }
    expect(result.content).toBe(JSON.stringify(command))
  })

  test("an empty part array and a non-part array stay JSON text", async () => {
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: [] } },
      { type: "tool_result", data: { id: "c2", name: "search", output: [{ path: "a.md" }] } },
      { type: "done", data: {} },
    ])
    const contents = events
      .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
      .map((e) => (e as { content: unknown }).content)
    expect(contents).toEqual(["[]", '[{"path":"a.md"}]'])
  })

  test("content_parts_dropped becomes a vendor-prefixed CUSTOM event", async () => {
    const data = {
      provider: "openai",
      model: "gpt-5-mini",
      parts: [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }],
    }
    const events = await collect([
      { type: "content_parts_dropped", data },
      { type: "token", data: "ok" },
      { type: "done", data: {} },
    ])
    expect(events[1]).toEqual({
      type: EventType.CUSTOM,
      name: "b4.content_parts_dropped",
      value: data,
    })
  })

  test("content_parts_dropped ends open assistant text first", async () => {
    const data = { provider: "openai", model: "gpt-5-mini", parts: [] }
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "content_parts_dropped", data },
      { type: "done", data: {} },
    ])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ])
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
