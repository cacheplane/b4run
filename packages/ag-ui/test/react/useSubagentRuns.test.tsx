import { type BaseEvent, EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE } from "../../src/activities.js"
import {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentRunsState,
} from "../../src/react/useSubagentRuns.js"

const RUN_STARTED = { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent
const STARTED = {
  type: EventType.SUBAGENT_STARTED,
  subagentRunId: "c1",
  name: "researcher",
  description: "Finds sources",
  parentToolCallId: "c1",
} as BaseEvent

function reduceAll(events: readonly BaseEvent[], initial = EMPTY_SUBAGENT_RUNS): SubagentRunsState {
  return events.reduce(reduceSubagentRuns, initial)
}

describe("reduceSubagentRuns", () => {
  test("SUBAGENT_STARTED opens a running invocation with its lineage", () => {
    const state = reduceAll([RUN_STARTED, STARTED])
    expect(state.threadId).toBe("t1")
    expect(state.runs.get("c1")).toEqual({
      subagentRunId: "c1",
      name: "researcher",
      description: "Finds sources",
      parentToolCallId: "c1",
      status: "running",
      children: [],
      toolCalls: [],
      text: "",
      reasoning: "",
    })
  })

  test("attributed text, reasoning, tool frames and plan land on their invocation", () => {
    const state = reduceAll([
      RUN_STARTED,
      STARTED,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "rsn",
        delta: "think",
        subagentRunId: "c1",
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hel", subagentRunId: "c1" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "lo", subagentRunId: "c1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "search",
        subagentRunId: "c1",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: '{"q":', subagentRunId: "c1" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: '"x"}', subagentRunId: "c1" },
      { type: EventType.TOOL_CALL_END, toolCallId: "t1", subagentRunId: "c1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr",
        toolCallId: "t1",
        content: "3 hits",
        subagentRunId: "c1",
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "b4:plan:c1",
        activityType: B4_PLAN_ACTIVITY_TYPE,
        content: { todos: [{ content: "read", status: "pending" }] },
        subagentRunId: "c1",
      },
      // Root events are never attributed, so they never land on a child.
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "root", delta: "ROOT" },
    ] as BaseEvent[])
    expect(state.runs.get("c1")).toMatchObject({
      reasoning: "think",
      text: "Hello",
      toolCalls: [
        { id: "t1", name: "search", args: '{"q":"x"}', result: "3 hits", status: "completed" },
      ],
      plan: [{ content: "read", status: "pending" }],
    })
  })

  test("finished, suspended and failed outcomes", () => {
    const done = reduceAll([
      RUN_STARTED,
      STARTED,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "c1",
        result: "found",
        outcome: { type: "success" },
      },
    ] as BaseEvent[])
    expect(done.runs.get("c1")).toMatchObject({ status: "completed", result: "found" })
    const suspended = reduceAll([
      RUN_STARTED,
      STARTED,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "c1",
        outcome: { type: "suspended", interruptIds: ["i"] },
      },
    ] as BaseEvent[])
    expect(suspended.runs.get("c1")).toMatchObject({ status: "suspended" })
    const failed = reduceAll([
      RUN_STARTED,
      STARTED,
      { type: EventType.SUBAGENT_ERROR, subagentRunId: "c1", message: "boom" },
    ] as BaseEvent[])
    expect(failed.runs.get("c1")).toMatchObject({ status: "failed", error: "boom" })
  })

  test("a nested invocation is listed under its parent", () => {
    const state = reduceAll([
      RUN_STARTED,
      STARTED,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "c2",
        name: "reader",
        parentSubagentRunId: "c1",
      },
    ] as BaseEvent[])
    expect(state.runs.get("c1")?.children).toEqual(["c2"])
    expect(state.runs.get("c2")).toMatchObject({ parentSubagentRunId: "c1", status: "running" })
  })

  test("a new run on another thread starts over; the same thread keeps and continues", () => {
    const first = reduceAll([
      RUN_STARTED,
      STARTED,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "a", subagentRunId: "c1" },
    ] as BaseEvent[])
    const resumed = reduceAll(
      [{ type: EventType.RUN_STARTED, threadId: "t1", runId: "r2" } as BaseEvent, STARTED],
      first,
    )
    expect(resumed.runs.get("c1")).toMatchObject({ status: "running", text: "a" })
    const other = reduceAll(
      [{ type: EventType.RUN_STARTED, threadId: "t2", runId: "r3" } as BaseEvent],
      first,
    )
    expect(other.runs.size).toBe(0)
    expect(other.threadId).toBe("t2")
  })

  test("events for an unannounced id are ignored; the state object is unchanged", () => {
    const state = reduceAll([RUN_STARTED])
    const next = reduceSubagentRuns(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m",
      delta: "x",
      subagentRunId: "ghost",
    } as BaseEvent)
    expect(next).toBe(state)
  })

  test("isSubagentMessage narrows a tagged transcript message", () => {
    expect(
      isSubagentMessage({ id: "1", role: "assistant", content: "x", subagentRunId: "c1" }),
    ).toBe(true)
    expect(isSubagentMessage({ id: "2", role: "assistant", content: "y" })).toBe(false)
  })
})
