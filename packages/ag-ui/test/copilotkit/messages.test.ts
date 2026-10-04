import type { Message } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { mergeTurnMessages } from "../../src/copilotkit/messages.js"

const user = (id: string): Message => ({ id, role: "user", content: "hi" })
const text = (id: string, content = "Answer."): Message => ({ id, role: "assistant", content })
const calls = (id: string, ...ids: string[]): Message => ({
  id,
  role: "assistant",
  content: "",
  toolCalls: ids.map((c) => ({
    id: c,
    type: "function",
    function: { name: "x", arguments: "{}" },
  })),
})
const result = (id: string, callId: string): Message => ({
  id,
  role: "tool",
  content: "ok",
  toolCallId: callId,
})

describe("mergeTurnMessages", () => {
  test("keeps one tool-only assistant message per turn, keeps tool results and text, and restarts at each user message", () => {
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
  })

  test("drops subagent messages and returns the same array when nothing changes", () => {
    const sub = { ...text("s1"), subagentRunId: "k1" } as Message
    expect(mergeTurnMessages([user("u1"), sub, text("a1")]).map((m) => m.id)).toEqual(["u1", "a1"])
    const stable = [user("u1"), text("a1")]
    expect(mergeTurnMessages(stable)).toBe(stable)
  })
})
