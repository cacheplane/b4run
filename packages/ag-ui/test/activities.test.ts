import { EventType } from "@ag-ui/core"
import { ActivitySnapshotEventSchema } from "@ag-ui/core/schemas"
import { describe, expect, test } from "vitest"
import {
  B4_PLAN_ACTIVITY_TYPE,
  createB4ActivityProjector as createUncheckedB4ActivityProjector,
  isB4ActivityChunkType,
} from "../src/activities.ts"

const todos = [
  { content: "Search the corpus", status: "completed" },
  { content: "Read the best source", status: "in_progress" },
] as const

function createB4ActivityProjector(runId: string) {
  const projector = createUncheckedB4ActivityProjector(runId)
  return {
    project(...args: Parameters<typeof projector.project>) {
      const { event } = projector.project(...args)
      if (event !== null) expect(ActivitySnapshotEventSchema.parse(event)).toEqual(event)
      return event
    },
  }
}

describe("isB4ActivityChunkType", () => {
  test("recognizes exactly plan_update: a subagent's lifecycle is not an activity", () => {
    expect(isB4ActivityChunkType("plan_update")).toBe(true)
    for (const other of [
      "subagent.start",
      "subagent.plan_update",
      "subagent.tool_call",
      "subagent.token",
      "subagent.end",
      "token",
      "plan_update.extra",
    ]) {
      expect(isB4ActivityChunkType(other)).toBe(false)
    }
  })
})

describe("createB4ActivityProjector", () => {
  test("emits complete plan replacements with one stable run-scoped id", () => {
    const projector = createB4ActivityProjector("run-1")
    const first = projector.project("plan_update", { todos: [todos[0]] })
    const second = projector.project("plan_update", { todos })

    expect(first).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "b4:plan:run-1",
      activityType: B4_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos: [todos[0]] },
    })
    expect(second).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "b4:plan:run-1",
      activityType: B4_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos },
    })
  })

  test("a subagent's plan has its own stable id and carries the child's subagentRunId", () => {
    const projector = createB4ActivityProjector("run-1")
    const child = projector.project("plan_update", { todos }, "call-research-1")

    expect(child).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "b4:plan:call-research-1",
      activityType: B4_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos },
      subagentRunId: "call-research-1",
    })
    // Root and child plans never collide, and root is never tagged.
    expect(projector.project("plan_update", { todos })).not.toHaveProperty("subagentRunId")
  })

  test("normalizes todo prose and rejects malformed plans", () => {
    const projector = createB4ActivityProjector("run-1")
    expect(
      projector.project("plan_update", { todos: [{ content: "  padded  ", status: "pending" }] }),
    ).toMatchObject({ content: { todos: [{ content: "padded", status: "pending" }] } })
    for (const bad of [
      { todos: [{ content: "bad", status: "unknown" }] },
      { todos: [{ content: "   ", status: "pending" }] },
      { todos: [{ status: "pending" }] },
      { todos: "not a list" },
      null,
      "todos",
    ]) {
      expect(projector.project("plan_update", bad)).toBeNull()
    }
  })

  test("returns null without throwing for hostile getters", () => {
    const projector = createB4ActivityProjector("run-1")
    const hostile = {
      get todos(): unknown {
        throw new Error("boom")
      },
    }
    expect(() => projector.project("plan_update", hostile)).not.toThrow()
    expect(projector.project("plan_update", hostile)).toBeNull()
  })
})

describe("orchestration correlation", () => {
  test("a valid root plan update correlates to its writeTodos call", () => {
    const projector = createUncheckedB4ActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "Search", status: "pending" }],
      tool_call_id: "call_writeTodos_0_1",
    })

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toEqual({
      toolCallId: "call_writeTodos_0_1",
      toolName: "writeTodos",
    })
    expect(JSON.stringify(projection.event?.content)).not.toContain("call_writeTodos_0_1")
  })

  test("a child's plan update never correlates: nothing of a child's is suppressed", () => {
    const projector = createUncheckedB4ActivityProjector("run-1")
    const projection = projector.project(
      "plan_update",
      { todos: [{ content: "Search", status: "pending" }], tool_call_id: "call_child_writeTodos" },
      "call-research-1",
    )

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toBeUndefined()
    expect(JSON.stringify(projection.event)).not.toContain("call_child_writeTodos")
  })

  test("a plan update without a correlation id yields no correlation", () => {
    const projector = createUncheckedB4ActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "Search", status: "pending" }],
    })

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toBeUndefined()
  })

  test("an empty or non-string correlation id yields no correlation", () => {
    const projector = createUncheckedB4ActivityProjector("run-1")
    const todos = [{ content: "Search", status: "pending" }]

    expect(
      projector.project("plan_update", { todos, tool_call_id: "" }).orchestration,
    ).toBeUndefined()
    expect(
      projector.project("plan_update", { todos, tool_call_id: 42 }).orchestration,
    ).toBeUndefined()
  })

  test("a malformed plan update yields neither event nor correlation", () => {
    const projector = createUncheckedB4ActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "bad", status: "unknown" }],
      tool_call_id: "call_writeTodos_0_1",
    })

    expect(projection.event).toBeNull()
    expect(projection.orchestration).toBeUndefined()
  })
})
