import { type BaseEvent, EventType } from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createCounterIdFactory } from "../../src/ids.ts"
import { toAguiEvents } from "../../src/outbound.ts"
import type { B4AgentStreamChunk } from "../../src/types.ts"
import {
  EMPTY_TURNS,
  reduceTurns,
  type SubagentStep,
  type ToolStep,
  type TurnsView,
} from "../../src/view/turns.ts"

const CTX = { threadId: "th-1", runId: "rn-1" }
const CHILD = {
  call_id: "call-task",
  subagent: "researcher",
  route_id: "/r#researcher",
  depth: 1,
} as const

async function* toAsync(items: readonly B4AgentStreamChunk[]) {
  yield* items
}

async function* thenThrow(items: readonly B4AgentStreamChunk[]): AsyncIterable<B4AgentStreamChunk> {
  yield* items
  throw new Error("boom")
}

/** A clock that advances 1000ms per read, so timing is deterministic. */
function fixedClock() {
  let t = 0
  return () => (t += 1000)
}

/** Run a B4 stream through the real translator, then fold the events. */
async function foldStream(
  stream: AsyncIterable<B4AgentStreamChunk>,
  clock = fixedClock(),
): Promise<TurnsView> {
  let view = EMPTY_TURNS
  for await (const event of toAguiEvents(stream, CTX, { idFactory: createCounterIdFactory() })) {
    view = reduceTurns(view, event as BaseEvent, { now: clock })
  }
  return view
}

function fold(chunks: readonly B4AgentStreamChunk[], clock = fixedClock()): Promise<TurnsView> {
  return foldStream(toAsync(chunks), clock)
}

/** Fold hand-written AG-UI events (no translator) with a deterministic clock. */
function foldEvents(events: readonly BaseEvent[], clock = fixedClock()): TurnsView {
  let view = EMPTY_TURNS
  for (const event of events) view = reduceTurns(view, event, { now: clock })
  return view
}

const step = (toolCallId: string, status: string, label?: string): BaseEvent =>
  ({
    type: EventType.CUSTOM,
    name: "b4.step",
    value: { toolCallId, status, ...(label !== undefined ? { label } : {}) },
  }) as BaseEvent

const RUN: B4AgentStreamChunk[] = [
  { type: "reasoning", data: "search first" },
  { type: "tool_call", data: { id: "c1", name: "recall", input: { query: "agents" } } },
  {
    type: "step",
    data: { tool_call_id: "c1", status: "running", icon: "memory", label: "Recalling “agents”" },
  },
  {
    type: "step",
    data: { tool_call_id: "c1", status: "completed", icon: "memory", label: "Checked memory" },
  },
  { type: "tool_result", data: { id: "c1", name: "recall", output: "(no memories found)" } },
  { type: "tool_call", data: { id: "c2", name: "writeTodos", input: { todos: [] } } },
  {
    type: "plan_update",
    data: { tool_call_id: "c2", todos: [{ content: "search", status: "in_progress" }] },
  },
  { type: "tool_result", data: { id: "c2", name: "writeTodos", output: "ok" } },
  { type: "tool_call", data: { id: "c3", name: "searchCorpus", input: { query: "a" } } },
  { type: "tool_result", data: { id: "c3", name: "searchCorpus", output: [{ path: "a.md" }] } },
  { type: "tool_call", data: { id: "c4", name: "searchCorpus", input: { query: "b" } } },
  { type: "tool_result", data: { id: "c4", name: "searchCorpus", output: [] } },
  {
    type: "tool_call",
    data: { id: CHILD.call_id, name: "task", input: { subagent: "researcher", input: "x" } },
  },
  { type: "subagent.start", data: { ...CHILD, description: "summarize ReAct" } },
  {
    type: "subagent.tool_call",
    data: { ...CHILD, id: "k1", name: "readDoc", input: { path: "a.md" } },
  },
  {
    type: "subagent.step",
    data: { ...CHILD, tool_call_id: "k1", status: "running", label: "Reading a.md" },
  },
  { type: "subagent.tool_result", data: { ...CHILD, id: "k1", name: "readDoc", output: "text" } },
  { type: "subagent.token", data: { ...CHILD, data: "ReAct is…", messageId: "m1" } },
  { type: "subagent.end", data: { ...CHILD, final_message: "ReAct is…" } },
  { type: "tool_result", data: { id: CHILD.call_id, name: "task", output: "ReAct is…" } },
  { type: "token", data: "Here is the comparison." },
  { type: "done", data: {} },
]

describe("reduceTurns", () => {
  it("builds one turn with steps in event order, hiding writeTodos behind the plan", async () => {
    const view = await fold(RUN)
    expect(view.threadId).toBe("th-1")
    expect(view.turns).toHaveLength(1)
    const [turn] = view.turns
    expect(turn?.status).toBe("done")
    expect(turn?.text).toBe("Here is the comparison.")
    expect(turn?.steps.map((s) => s.kind)).toEqual([
      "reasoning",
      "tool",
      "plan",
      "tool",
      "tool",
      "subagent",
    ])
  })

  it("merges b4.step labels, icons and sources into the tool step", async () => {
    const view = await fold(RUN)
    const recall = view.turns[0]?.steps[1] as ToolStep
    expect(recall).toMatchObject({
      kind: "tool",
      id: "c1",
      name: "recall",
      status: "done",
      icon: "memory",
      label: "Checked memory",
      result: "(no memories found)",
    })
    expect(recall.args).toBe('{"query":"agents"}')
  })

  it("leaves the label undefined for a call that never had a b4.step", async () => {
    const view = await fold(RUN)
    const search = view.turns[0]?.steps[3] as ToolStep
    expect(search).toMatchObject({ kind: "tool", id: "c3", name: "searchCorpus", status: "done" })
    expect(search.label).toBeUndefined()
  })

  it("keeps the plan in place and updated", async () => {
    const view = await fold(RUN)
    expect(view.turns[0]?.steps[2]).toMatchObject({
      kind: "plan",
      todos: [{ content: "search", status: "in_progress" }],
    })
  })

  it("replaces the task call with a subagent step holding a nested turn", async () => {
    const view = await fold(RUN)
    const subagent = view.turns[0]?.steps[5] as SubagentStep
    expect(subagent).toMatchObject({
      kind: "subagent",
      id: CHILD.call_id,
      name: "researcher",
      description: "summarize ReAct",
      status: "done",
    })
    expect(subagent.turn.steps.map((s) => s.kind)).toEqual(["tool"])
    expect(subagent.turn.steps[0]).toMatchObject({
      id: "k1",
      name: "readDoc",
      label: "Reading a.md",
      status: "done",
    })
    expect(subagent.turn.text).toBe("ReAct is…")
    expect(subagent.turn.status).toBe("done")
  })

  it("marks a failed step from a failed b4.step and leaves the turn done", async () => {
    const view = await fold([
      { type: "tool_call", data: { id: "e1", name: "readDoc", input: {} } },
      {
        type: "tool_result",
        data: {
          id: "e1",
          name: "readDoc",
          output: { status: "error", content: "ENOENT", name: "readDoc", tool_call_id: "e1" },
        },
      },
      { type: "done", data: {} },
    ])
    expect(view.turns[0]?.steps[0]).toMatchObject({
      kind: "tool",
      status: "failed",
      result: "ENOENT",
    })
    expect(view.turns[0]?.status).toBe("done")
    expect(view.turns[0]?.failed).toBe(1)
  })

  it("attaches an interrupt to its tool step and pauses the subagent above it", async () => {
    const view = await fold([
      { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
      { type: "subagent.start", data: CHILD },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "k2", name: "runBash", input: { command: "node x" } },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-1",
          type: "permission-request",
          kind: "command",
          callId: CHILD.call_id,
          toolCallId: "k2",
          detail: { command: "node x", suggestedPattern: "node x" },
        },
      },
    ])
    const turn = view.turns[0]
    expect(turn?.status).toBe("awaiting")
    const subagent = turn?.steps[0] as SubagentStep
    expect(subagent.status).toBe("paused")
    expect(subagent.turn.status).toBe("awaiting")
    const gated = subagent.turn.steps[0] as ToolStep
    expect(gated.status).toBe("awaiting")
    expect(gated.approval).toMatchObject({
      interruptId: "perm-1",
      kind: "command",
      detail: { command: "node x" },
      offersAlways: true,
    })
    expect(turn?.approvals).toEqual([])
  })

  it("keeps an interrupt that names no step on the turn", async () => {
    const view = await fold([
      { type: "interrupt", data: { interruptId: "x-1", kind: "custom", message: "look" } },
    ])
    expect(view.turns[0]?.status).toBe("awaiting")
    expect(view.turns[0]?.steps).toEqual([])
    expect(view.turns[0]?.approvals).toEqual([
      { interruptId: "x-1", kind: "custom", detail: {}, offersAlways: false, message: "look" },
    ])
  })

  it("fails running steps and the turn on RUN_ERROR", async () => {
    const errored = await foldStream(
      thenThrow([
        { type: "tool_call", data: { id: "r1", name: "searchCorpus", input: {} } },
        { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching" } },
      ]),
    )
    expect(errored.turns[0]?.status).toBe("failed")
    expect(errored.turns[0]?.error).toBe("boom")
    expect(errored.turns[0]?.steps[0]).toMatchObject({ status: "failed", label: "Searching" })
    expect(errored.turns[0]?.failed).toBe(1)
  })

  it("stops the turn on a cancelled outcome", () => {
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: { type: "cancelled" },
      } as BaseEvent,
    ])
    expect(view.turns[0]?.status).toBe("stopped")
  })

  it("merges repeated running steps for one call into a single step and never downgrades done", async () => {
    // LangGraph re-executes a resumed tool node, so the converter dispatches a
    // second `running` for the same tool_call_id before `completed`.
    const view = await fold([
      { type: "tool_call", data: { id: "r1", name: "searchCorpus", input: { query: "a" } } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching" } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching again" } },
      { type: "tool_result", data: { id: "r1", name: "searchCorpus", output: "ok" } },
      { type: "step", data: { tool_call_id: "r1", status: "completed", label: "Searched" } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Late running" } },
      { type: "done", data: {} },
    ])
    const tools = view.turns[0]?.steps.filter((s) => s.kind === "tool") ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: "r1", status: "done", label: "Late running" })
  })

  it("accepts the completed step before or after the result, to the same step", () => {
    const start: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "recall" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
    ]
    const result = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m",
      toolCallId: "t1",
      content: "found",
    } as BaseEvent
    const before = foldEvents([...start, step("t1", "completed", "Checked"), result])
    const after = foldEvents([...start, result, step("t1", "completed", "Checked")])
    expect(before).toEqual(after)
    expect(before.turns[0]?.steps[0]).toMatchObject({
      status: "done",
      label: "Checked",
      result: "found",
      settledAt: 3000,
    })
  })

  it("marks the step failed when a failed b4.step follows its result", () => {
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "readDoc" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m",
        toolCallId: "t1",
        content: "ENOENT",
      } as BaseEvent,
      step("t1", "failed"),
    ])
    expect(view.turns[0]?.steps[0]).toMatchObject({ status: "failed", result: "ENOENT" })
    expect(view.turns[0]?.failed).toBe(1)
  })

  it("is idempotent for a settled call: re-applying its result and completed step changes nothing", () => {
    const clock = fixedClock()
    const settle: BaseEvent[] = [
      step("t1", "completed", "Checked"),
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m",
        toolCallId: "t1",
        content: "found",
      } as BaseEvent,
    ]
    const once = foldEvents(
      [
        { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
        { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "recall" } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
        ...settle,
      ],
      clock,
    )
    let twice = once
    for (const event of settle) twice = reduceTurns(twice, event, { now: clock })
    expect(twice).toEqual(once)
  })

  it("leaves a client-executed tool pending when the run finishes with it outstanding", () => {
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "pickFile" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: { type: "success", pendingToolCallIds: ["t1"] },
      } as BaseEvent,
    ])
    expect(view.turns[0]?.status).toBe("done")
    expect(view.turns[0]?.steps[0]).toMatchObject({ status: "running" })
    expect(view.turns[0]?.failed).toBe(0)
  })

  it("starts over on a different thread and appends a turn on the same one", () => {
    const first = reduceTurns(EMPTY_TURNS, {
      type: EventType.RUN_STARTED,
      threadId: "a",
      runId: "1",
    } as BaseEvent)
    const second = reduceTurns(first, {
      type: EventType.RUN_STARTED,
      threadId: "a",
      runId: "2",
    } as BaseEvent)
    expect(second.turns.map((turn) => turn.runId)).toEqual(["1", "2"])
    const other = reduceTurns(second, {
      type: EventType.RUN_STARTED,
      threadId: "b",
      runId: "3",
    } as BaseEvent)
    expect(other.turns.map((turn) => turn.runId)).toEqual(["3"])
  })

  it("ignores events before any turn and b4.step for a call it never saw framed", () => {
    expect(
      reduceTurns(EMPTY_TURNS, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m",
        delta: "x",
      } as BaseEvent),
    ).toEqual(EMPTY_TURNS)
    const started = reduceTurns(EMPTY_TURNS, {
      type: EventType.RUN_STARTED,
      threadId: "a",
      runId: "1",
    } as BaseEvent)
    expect(reduceTurns(started, step("ghost", "running", "Hm"))).toBe(started)
  })

  it("is a pure function of the events: replaying yields a deep-equal view", async () => {
    const a = await fold(RUN, fixedClock())
    const b = await fold(RUN, fixedClock())
    expect(a).toEqual(b)
  })
})
