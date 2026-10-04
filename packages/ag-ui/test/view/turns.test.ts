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

/** Continue folding a later run (its own ctx) into an existing view through the translator. */
async function foldInto(
  view: TurnsView,
  chunks: readonly B4AgentStreamChunk[],
  ctx: { threadId: string; runId: string },
  clock: () => number,
): Promise<TurnsView> {
  let next = view
  const stream = toAguiEvents(toAsync(chunks), ctx, { idFactory: createCounterIdFactory() })
  for await (const event of stream) next = reduceTurns(next, event as BaseEvent, { now: clock })
  return next
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

  it("resumes the awaiting turn on the next run of the same thread: one turn, no approvals", async () => {
    const clock = fixedClock()
    const run1 = await fold(
      [
        { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
        { type: "subagent.start", data: CHILD },
        { type: "subagent.tool_call", data: { ...CHILD, id: "k1", name: "readDoc", input: {} } },
        {
          type: "subagent.tool_result",
          data: { ...CHILD, id: "k1", name: "readDoc", output: "t" },
        },
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
            detail: { command: "node x" },
          },
        },
      ],
      clock,
    )
    expect(run1.turns[0]?.status).toBe("awaiting")
    let view = run1
    const resumed: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-2" } as BaseEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: CHILD.call_id,
        name: "researcher",
        parentToolCallId: CHILD.call_id,
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m",
        toolCallId: "k2",
        content: "ran",
        subagentRunId: CHILD.call_id,
      } as BaseEvent,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: CHILD.call_id,
        outcome: { type: "success" },
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m2",
        toolCallId: CHILD.call_id,
        content: "done",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-2",
        outcome: { type: "success" },
      } as BaseEvent,
    ]
    for (const event of resumed) view = reduceTurns(view, event, { now: clock })
    expect(view.turns).toHaveLength(1)
    const turn = view.turns[0]
    expect(turn).toMatchObject({ runId: "rn-2", status: "done", approvals: [] })
    expect(turn?.startedAt).toBe(run1.turns[0]?.startedAt)
    const subagent = turn?.steps[0] as SubagentStep
    expect(subagent).toMatchObject({ status: "done" })
    expect(subagent.turn).toMatchObject({ status: "done", approvals: [] })
    expect(subagent.turn.steps.map((s) => s.id)).toEqual(["k1", "k2"])
    const gated = subagent.turn.steps[1] as ToolStep
    expect(gated).toMatchObject({ status: "done", result: "ran" })
    expect(gated.approval).toBeUndefined()
  })

  it("resets a turn in place when its RUN_STARTED is replayed from the start", async () => {
    const once = await fold(RUN, fixedClock())
    const clock = fixedClock()
    let view = EMPTY_TURNS
    for (let pass = 0; pass < 2; pass++) {
      const events = toAguiEvents(toAsync(RUN), CTX, { idFactory: createCounterIdFactory() })
      for await (const event of events) view = reduceTurns(view, event as BaseEvent, { now: clock })
      if (pass === 0) clock() // the second pass starts one tick later; only timing may differ
    }
    expect(view.turns).toHaveLength(1)
    const strip = (v: TurnsView) =>
      JSON.parse(
        JSON.stringify(v).replace(/"(startedAt|updatedAt|settledAt|endedAt)":\d+/g, '"$1":0'),
      )
    expect(strip(view)).toEqual(strip(once))
  })

  it("settles an open subagent's nested turn as failed on RUN_ERROR, carrying the error", async () => {
    const view = await foldStream(
      thenThrow([
        { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
        { type: "subagent.start", data: CHILD },
        { type: "subagent.tool_call", data: { ...CHILD, id: "k1", name: "readDoc", input: {} } },
      ]),
    )
    const subagent = view.turns[0]?.steps[0] as SubagentStep
    expect(subagent).toMatchObject({ status: "failed", error: "boom" })
    expect(subagent.turn).toMatchObject({ status: "failed", error: "boom" })
    expect(subagent.turn.endedAt).toBeDefined()
    expect(subagent.turn.steps[0]).toMatchObject({ status: "failed" })
    expect(view.turns[0]?.failed).toBe(2)
  })

  it("counts a child's failed step on the root before the subagent finishes", () => {
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: CHILD.call_id, name: "r" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "k1",
        toolCallName: "readDoc",
        subagentRunId: CHILD.call_id,
      } as BaseEvent,
      {
        type: EventType.CUSTOM,
        name: "b4.step",
        value: { toolCallId: "k1", status: "failed" },
        subagentRunId: CHILD.call_id,
      } as BaseEvent,
    ])
    const subagent = view.turns[0]?.steps[0] as SubagentStep
    expect(subagent.status).toBe("running")
    expect(subagent.turn.failed).toBe(1)
    expect(view.turns[0]?.failed).toBe(1)
  })

  it("pauses every ancestor and marks each nested turn awaiting at depth 2", () => {
    const GRANDCHILD = "call-grand"
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: CHILD.call_id, name: "r" } as BaseEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: GRANDCHILD,
        name: "g",
        parentSubagentRunId: CHILD.call_id,
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "g1",
        toolCallName: "runBash",
        subagentRunId: GRANDCHILD,
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i", reason: "command", toolCallId: "g1", subagentRunId: GRANDCHILD }],
        },
      } as BaseEvent,
    ])
    const child = view.turns[0]?.steps[0] as SubagentStep
    const grand = child.turn.steps[0] as SubagentStep
    expect(view.turns[0]?.status).toBe("awaiting")
    expect(child).toMatchObject({ status: "paused" })
    expect(child.turn.status).toBe("awaiting")
    expect(grand).toMatchObject({ status: "paused" })
    expect(grand.turn.status).toBe("awaiting")
    expect(grand.turn.steps[0]).toMatchObject({ status: "awaiting" })
  })

  it("routes reasoning content by messageId across interleaved spans", () => {
    const content = (messageId: string, delta: string): BaseEvent =>
      ({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta }) as BaseEvent
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.REASONING_START, messageId: "ma" } as BaseEvent,
      { type: EventType.REASONING_START, messageId: "mb" } as BaseEvent,
      content("ma", "A1"),
      content("mb", "B1"),
      content("ma", "A2"),
      { type: EventType.REASONING_END, messageId: "ma" } as BaseEvent,
    ])
    const steps = view.turns[0]?.steps ?? []
    expect(steps.map((s) => (s.kind === "reasoning" ? s.text : ""))).toEqual(["A1A2", "B1"])
    expect(steps[0]).toMatchObject({ status: "done" })
    expect(steps[1]).toMatchObject({ status: "streaming" })
  })

  it("streams a reasoning message inside its span rather than opening a second step", async () => {
    const view = await fold([
      { type: "reasoning", data: "think" },
      { type: "reasoning", data: " more" },
      { type: "token", data: "answer" },
      { type: "done", data: {} },
    ])
    const reasoning = view.turns[0]?.steps.filter((s) => s.kind === "reasoning") ?? []
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ text: "think more", status: "done" })
  })

  it("separates text messages split by a tool call with one newline", async () => {
    const view = await fold([
      { type: "token", data: "Let me look." },
      { type: "tool_call", data: { id: "c1", name: "searchCorpus", input: {} } },
      { type: "tool_result", data: { id: "c1", name: "searchCorpus", output: "x" } },
      { type: "token", data: "Found it." },
      { type: "done", data: {} },
    ])
    expect(view.turns[0]?.text).toBe("Let me look.\nFound it.")
  })

  it("drops the frames of hidden tools", async () => {
    let view = EMPTY_TURNS
    const stream = toAguiEvents(
      toAsync([
        { type: "tool_call", data: { id: "c1", name: "think", input: {} } },
        { type: "tool_result", data: { id: "c1", name: "think", output: "x" } },
        { type: "done", data: {} },
      ]),
      CTX,
      { idFactory: createCounterIdFactory() },
    )
    for await (const event of stream) {
      view = reduceTurns(view, event as BaseEvent, { now: fixedClock(), hiddenTools: ["think"] })
    }
    expect(view.turns[0]?.steps).toEqual([])
    expect(view.turns[0]?.status).toBe("done")
  })

  it("keeps a child's plan on the child's turn", async () => {
    const view = await fold([
      { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
      { type: "subagent.start", data: CHILD },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, tool_call_id: "k9", todos: [{ content: "read", status: "pending" }] },
      },
    ])
    const subagent = view.turns[0]?.steps[0] as SubagentStep
    expect(subagent.turn.steps).toEqual([
      expect.objectContaining({ kind: "plan", todos: [{ content: "read", status: "pending" }] }),
    ])
    expect(view.turns[0]?.steps.filter((s) => s.kind === "plan")).toEqual([])
  })

  it("ignores a malformed plan snapshot", () => {
    const started = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
    ])
    const next = reduceTurns(started, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "p",
      activityType: "b4.plan",
      replace: true,
      content: { todos: [{ content: "x", status: "weird" }] },
    } as BaseEvent)
    expect(next).toBe(started)
  })

  it("passes the grant through on an approval", () => {
    const view = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: {
          type: "interrupt",
          interrupts: [
            { id: "i", reason: "tool", metadata: { grant: "g-1", detail: { tool: "x" } } },
          ],
        },
      } as BaseEvent,
    ])
    expect(view.turns[0]?.approvals[0]).toMatchObject({ grant: "g-1", detail: { tool: "x" } })
  })

  it("returns the same state for events that change nothing", () => {
    const started = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "recall" } as BaseEvent,
      step("t1", "running", "Recalling"),
    ])
    expect(reduceTurns(started, step("t1", "running", "Recalling"))).toBe(started)
    expect(
      reduceTurns(started, {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "t1",
        delta: "",
      } as BaseEvent),
    ).toBe(started)
    expect(
      reduceTurns(started, { type: EventType.REASONING_END, messageId: "nope" } as BaseEvent),
    ).toBe(started)
    expect(
      reduceTurns(started, { type: EventType.RUN_STARTED, threadId: 42, runId: "2" } as BaseEvent),
    ).toBe(started)
  })

  it("resets the args of a call the resumed run re-presents, so they are not doubled", async () => {
    const clock = fixedClock()
    const gated: B4AgentStreamChunk = {
      type: "tool_call",
      data: { id: "c1", name: "runBash", input: { command: "node x" } },
    }
    const paused = await fold(
      [
        gated,
        {
          type: "interrupt",
          data: {
            interruptId: "perm-1",
            type: "permission-request",
            kind: "command",
            toolCallId: "c1",
            detail: { command: "node x" },
          },
        },
      ],
      clock,
    )
    expect(paused.turns[0]?.steps[0]).toMatchObject({
      status: "awaiting",
      args: '{"command":"node x"}',
    })
    const view = await foldInto(
      paused,
      [
        gated,
        { type: "tool_result", data: { id: "c1", name: "runBash", output: "ran" } },
        { type: "done", data: {} },
      ],
      { threadId: CTX.threadId, runId: "rn-2" },
      clock,
    )
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.steps).toHaveLength(1)
    expect(view.turns[0]?.steps[0]).toMatchObject({
      status: "done",
      args: '{"command":"node x"}',
      result: "ran",
    })
    expect(view.turns[0]?.approvals).toEqual([])
  })

  it("replays an earlier run by restarting the view from that turn", () => {
    const run = (runId: string): BaseEvent[] => [
      { type: EventType.RUN_STARTED, threadId: "a", runId } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId,
        outcome: { type: "success" },
      } as BaseEvent,
    ]
    const two = foldEvents([...run("1"), ...run("2")])
    expect(two.turns.map((t) => t.runId)).toEqual(["1", "2"])
    const lastAgain = reduceTurns(two, run("2")[0] as BaseEvent)
    expect(lastAgain.turns.map((t) => [t.runId, t.status])).toEqual([
      ["1", "done"],
      ["2", "working"],
    ])
    const firstAgain = reduceTurns(two, run("1")[0] as BaseEvent)
    expect(firstAgain.turns.map((t) => [t.runId, t.status])).toEqual([["1", "working"]])
  })

  it("follows an explicit resuming flag over the awaiting heuristic", () => {
    const awaiting = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: { type: "interrupt", interrupts: [{ id: "i", reason: "custom" }] },
      } as BaseEvent,
    ])
    const next = { type: EventType.RUN_STARTED, threadId: "a", runId: "2" } as BaseEvent
    expect(reduceTurns(awaiting, next, { resuming: false }).turns.map((t) => t.runId)).toEqual([
      "1",
      "2",
    ])
    const done = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "a",
        runId: "1",
        outcome: { type: "success" },
      } as BaseEvent,
    ])
    const glued = reduceTurns(done, next, { resuming: true })
    expect(glued.turns.map((t) => [t.runId, t.status])).toEqual([["2", "working"]])
  })

  describe("never throws on malformed input", () => {
    const empty = EMPTY_TURNS
    const midRun = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
    ])
    const midTool = foldEvents([
      { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "recall" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" } as BaseEvent,
    ])
    const bases: Array<[string, TurnsView]> = [
      ["empty", empty],
      ["mid-run", midRun],
      ["mid-tool", midTool],
    ]
    const result = (content: unknown) =>
      ({ type: EventType.TOOL_CALL_RESULT, messageId: "m", toolCallId: "t1", content }) as BaseEvent
    const finished = (outcome: unknown) =>
      ({ type: EventType.RUN_FINISHED, threadId: "a", runId: "1", outcome }) as BaseEvent
    const shapes: Array<[string, unknown, boolean]> = [
      ["result content missing", result(undefined), false],
      ["result content null", result(null), false],
      ["result content number", result(5), false],
      ["result content [null]", result([null]), false],
      ["interrupts missing", finished({ type: "interrupt" }), false],
      ["interrupts null", finished({ type: "interrupt", interrupts: null }), false],
      ["interrupts [null]", finished({ type: "interrupt", interrupts: [null] }), false],
      [
        "pendingToolCallIds non-array",
        finished({ type: "success", pendingToolCallIds: "x" }),
        false,
      ],
      ["null event", null, true],
      ["number event", 42, true],
      ["string event", "RUN_STARTED", true],
      [
        "args delta non-string",
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: 3 },
        true,
      ],
      [
        "text delta non-string",
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: null },
        true,
      ],
      [
        "reasoning delta non-string",
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "m", delta: {} },
        true,
      ],
    ]
    for (const [base, state] of bases) {
      for (const [name, event, identity] of shapes) {
        it(`${name} from ${base}`, () => {
          let next: TurnsView | undefined
          expect(() => {
            next = reduceTurns(state, event as BaseEvent)
          }).not.toThrow()
          if (identity) expect(next).toBe(state)
        })
      }
    }

    it("reads the text parts of a result and treats other content as empty", () => {
      const parts = reduceTurns(
        midTool,
        result([{ type: "text", text: "a" }, null, { type: "image" }]),
      )
      expect(parts.turns[0]?.steps[0]).toMatchObject({ status: "done", result: "a" })
      const number = reduceTurns(midTool, result(5))
      expect(number.turns[0]?.steps[0]).toMatchObject({ status: "done", result: "" })
    })
  })

  it("is a pure function of the events: replaying yields a deep-equal view", async () => {
    const a = await fold(RUN, fixedClock())
    const b = await fold(RUN, fixedClock())
    expect(a).toEqual(b)
  })
})
