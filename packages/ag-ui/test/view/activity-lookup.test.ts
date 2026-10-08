import { describe, expect, test } from "vitest"
import {
  approvalFromInterrupt,
  approvalLabel,
  approvalPrompt,
  pendingApprovals,
  type TranscriptMessage,
  toolCallIdsOf,
  turnForMessage,
  turnForToolCalls,
} from "../../src/view/activity-lookup.ts"
import type { TurnsView } from "../../src/view/turns.ts"
import { approval, subagent, tool, turn } from "../fixtures/activity-fixtures.ts"

const user = (id: string): TranscriptMessage => ({ id, role: "user" })
const assistant = (id: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ id: c })) } : {}),
})

const turns: TurnsView = {
  threadId: "t",
  turns: [
    turn({ runId: "r1", steps: [tool("c1")] }),
    turn({ runId: "r2", steps: [] }),
    turn({
      runId: "r3",
      steps: [subagent({ id: "s1", turn: turn({ runId: "s1", steps: [tool("n1")] }) })],
    }),
  ],
}

describe("turnForToolCalls", () => {
  test("finds the turn owning a call, nested calls and subagent ids included", () => {
    expect(turnForToolCalls(turns, ["c1"])?.runId).toBe("r1")
    expect(turnForToolCalls(turns, ["n1"])?.runId).toBe("r3")
    expect(turnForToolCalls(turns, ["s1"])?.runId).toBe("r3")
    expect(turnForToolCalls(turns, ["nope"])).toBeUndefined()
    expect(turnForToolCalls(turns, [])).toBeUndefined()
  })
})

describe("turnForMessage", () => {
  const messages: TranscriptMessage[] = [
    user("u1"),
    assistant("a1", "c1"),
    { id: "t1", role: "tool" },
    assistant("a2"),
    user("u2"),
    assistant("a3"),
    user("u3"),
    assistant("a4"),
    { id: "x", role: "assistant", subagentRunId: "s1" } as TranscriptMessage,
    assistant("a5", "n1"),
  ]

  test("by tool calls: every assistant message of the run maps to its turn; only the first is first", () => {
    expect(turnForMessage(turns, messages, "a1")).toEqual({ turn: turns.turns[0], first: true })
    expect(turnForMessage(turns, messages, "a2")).toEqual({ turn: turns.turns[0], first: false })
    // a4 carries no calls, but its run's a5 does.
    expect(turnForMessage(turns, messages, "a4")).toEqual({ turn: turns.turns[2], first: true })
    expect(turnForMessage(turns, messages, "a5")).toEqual({ turn: turns.turns[2], first: false })
  })

  test("by position from the end when the run has no tool calls", () => {
    expect(turnForMessage(turns, messages, "a3")).toEqual({ turn: turns.turns[1], first: true })
  })

  test("a trailing user message whose run has not started does not shift the runs before it", () => {
    const pending = [...messages, user("u4")]
    expect(turnForMessage(turns, pending, "a3")).toEqual({ turn: turns.turns[1], first: true })
  })

  test("a live first message with text only maps to the newest turn", () => {
    const live = [user("u1"), assistant("a1", "c1"), user("u2"), assistant("a2")]
    const two: TurnsView = {
      turns: [turns.turns[0], turns.turns[1]].filter((t) => t !== undefined),
    }
    expect(turnForMessage(two, live, "a2")).toEqual({ turn: turns.turns[1], first: true })
  })

  test("a host transcript with toolCallIds instead of toolCalls finds the same turns", () => {
    const hostShape: TranscriptMessage[] = messages.map((m) => {
      const ids = toolCallIdsOf(m)
      return ids.length > 0 ? { id: m.id, role: m.role, toolCallIds: [...ids] } : m
    })
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
      expect(turnForMessage(turns, hostShape, id)).toEqual(turnForMessage(turns, messages, id))
    }
    expect(turnForMessage(turns, hostShape, "a5")).toEqual({ turn: turns.turns[2], first: false })
  })

  test("undefined for a user message, a subagent message, an unknown id, or no turn", () => {
    expect(turnForMessage(turns, messages, "u1")).toBeUndefined()
    expect(turnForMessage(turns, messages, "x")).toBeUndefined()
    expect(turnForMessage(turns, messages, "zz")).toBeUndefined()
    expect(turnForMessage({ turns: [] }, [user("u"), assistant("a")], "a")).toBeUndefined()
  })
})

describe("toolCallIdsOf", () => {
  test("reads toolCalls, else toolCallIds, else nothing", () => {
    expect(toolCallIdsOf({ id: "a", role: "assistant", toolCalls: [{ id: "c1" }] })).toEqual(["c1"])
    expect(toolCallIdsOf({ id: "a", role: "assistant", toolCallIds: ["c1", "c2"] })).toEqual([
      "c1",
      "c2",
    ])
    // toolCalls wins when both are present.
    const both = { id: "a", role: "assistant", toolCalls: [{ id: "x" }], toolCallIds: ["y"] }
    expect(toolCallIdsOf(both as TranscriptMessage)).toEqual(["x"])
    expect(toolCallIdsOf({ id: "a", role: "assistant" })).toEqual([])
  })
})

describe("approvals", () => {
  const interrupt = {
    id: "i1",
    reason: "tool",
    toolCallId: "c1",
    message: "Check first.",
    responseSchema: { type: "string", enum: ["once", "always", "deny"] },
    metadata: { kind: "command", detail: { command: "node x" }, grant: "g1" },
  }

  test("approvalFromInterrupt reads kind, detail, message, grant and the always offer", () => {
    expect(approvalFromInterrupt(interrupt)).toEqual({
      interruptId: "i1",
      kind: "command",
      detail: { command: "node x" },
      message: "Check first.",
      grant: "g1",
      offersAlways: true,
    })
    expect(approvalFromInterrupt({ id: "i2", reason: "tool" })).toEqual({
      interruptId: "i2",
      kind: "tool",
      detail: {},
      offersAlways: false,
    })
  })

  test("approvalLabel: the running label lower-cased, else 'use X'", () => {
    expect(approvalLabel(tool("c", { label: "Run a command" }), undefined)).toBe("run a command")
    expect(approvalLabel(tool("c", { name: "runBash", label: undefined }), undefined)).toBe(
      "use runBash",
    )
  })

  test("approvalPrompt names the subagent that owns the gated call, at any depth", () => {
    expect(approvalPrompt(turns, { toolCallId: "c1" }, undefined)).toEqual({
      agent: "The agent",
      label: "searched the corpus",
    })
    expect(approvalPrompt(turns, { toolCallId: "n1" }, undefined)).toEqual({
      agent: "researcher",
      label: "searched the corpus",
    })
    expect(approvalPrompt(turns, { subagentRunId: "s1" }, undefined)).toEqual({
      agent: "researcher",
      label: "continue",
    })
    expect(approvalPrompt(turns, {}, undefined)).toEqual({ agent: "The agent", label: "continue" })
  })

  test("pendingApprovals: awaiting steps of the last awaiting turn, nested, then unattached", () => {
    const gate = approval({ interruptId: "g" })
    const child = approval({ interruptId: "n" })
    const loose = approval({ interruptId: "l" })
    const parked: TurnsView = {
      turns: [
        turn({
          status: "awaiting",
          steps: [
            tool("c1", { status: "awaiting", approval: gate, label: "Run a command" }),
            subagent({
              status: "paused",
              turn: turn({
                status: "awaiting",
                steps: [tool("n1", { status: "awaiting", approval: child, label: "Fetch it" })],
              }),
            }),
          ],
          approvals: [loose],
        }),
      ],
    }
    expect(pendingApprovals(parked, undefined)).toEqual([
      { approval: gate, agent: "The agent", label: "run a command" },
      { approval: child, agent: "researcher", label: "fetch it" },
      { approval: loose, agent: "The agent", label: "continue" },
    ])
    expect(pendingApprovals(turns, undefined)).toEqual([])
    expect(pendingApprovals({ turns: [] }, undefined)).toEqual([])
  })
})
