import type { Message } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { mergeTurnMessages } from "../../../src/react/copilotkit/messages.js"

const user = (id: string): Message => ({ id, role: "user", content: "hi" })
const text = (id: string, content = "Answer."): Message => ({ id, role: "assistant", content })
/** CopilotKit's real tool-only row: `content` is absent, not `""`. */
const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "x", arguments: "{}" },
})
const calls = (id: string, ...ids: string[]): Message => ({
  id,
  role: "assistant",
  toolCalls: ids.map(call),
})
const result = (id: string, callId: string): Message => ({
  id,
  role: "tool",
  content: "ok",
  toolCallId: callId,
})
const toolCallIds = (m: Message | undefined): string[] =>
  m?.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : []

describe("mergeTurnMessages", () => {
  test("keeps the first tool-only row per turn with the union of the turn's tool calls, keeps results and text, and restarts at each user message", () => {
    const out = mergeTurnMessages([
      user("u1"),
      calls("a1", "c1"),
      result("t1", "c1"),
      calls("a2", "c2"),
      result("t2", "c2"),
      text("a3"),
      user("u2"),
      calls("b1", "c3"),
      result("t3", "c3"),
      text("b2"),
    ])
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "t1", "t2", "a3", "u2", "b1", "t3", "b2"])
    expect(toolCallIds(out[1])).toEqual(["c1", "c2"])
    expect(toolCallIds(out[6])).toEqual(["c3"])
  })

  test("a row with an empty-string content counts as tool-only and duplicate call ids are kept once", () => {
    const empty: Message = { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] }
    const out = mergeTurnMessages([user("u1"), empty, calls("a2", "c1", "c2")])
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"])
    expect(toolCallIds(out[1])).toEqual(["c1", "c2"])
  })

  test("a row carrying text and calls (B4's parentMessageId grouping) is the turn's row; later text keeps its words, not its calls", () => {
    const withText = (id: string, content: string, ...ids: string[]): Message => ({
      id,
      role: "assistant",
      content,
      toolCalls: ids.map(call),
    })
    const out = mergeTurnMessages([
      user("u1"),
      withText("a1", "Looking.", "c1", "c2"),
      result("t1", "c1"),
      result("t2", "c2"),
      calls("a2", "c3"),
      result("t3", "c3"),
      withText("a3", "One more.", "c4"),
      result("t4", "c4"),
      text("a4"),
    ])
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "t1", "t2", "t3", "a3", "t4", "a4"])
    expect(toolCallIds(out[1])).toEqual(["c1", "c2", "c3", "c4"])
    expect(out[1]).toMatchObject({ content: "Looking." })
    expect(out[5]).toEqual({ id: "a3", role: "assistant", content: "One more." })
    // Exactly one row per turn carries calls: one activity.
    expect(out.filter((m) => toolCallIds(m).length > 0)).toHaveLength(1)
  })

  test("drops subagent messages and returns the same array when nothing changes", () => {
    const sub = { ...text("s1"), subagentRunId: "k1" } as Message
    expect(mergeTurnMessages([user("u1"), sub, text("a1")]).map((m) => m.id)).toEqual(["u1", "a1"])
    const stable = [user("u1"), calls("a1", "c1"), result("t1", "c1"), text("a2")]
    expect(mergeTurnMessages(stable)).toBe(stable)
  })
})
