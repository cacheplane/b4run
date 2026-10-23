import type { RunAgentInput } from "@ag-ui/core"
import { expect, test } from "vitest"
import { fromRunAgentInput } from "../src/inbound.ts"

for (const onCall of [false, true]) {
  test(`drops provider results marked on the ${onCall ? "assistant call" : "tool message"} and preserves content and raw input`, () => {
    const metadata = { "b4.step": { v: 1, kind: "provider", status: "completed" } }
    const content = [{ type: "text", text: "client output" }]
    const input = {
      threadId: "t",
      runId: "r",
      tools: [],
      context: [],
      messages: [
        { id: "u", role: "user", content: "hello" },
        {
          id: "a",
          role: "assistant",
          content: "answer",
          toolCalls: [
            {
              id: "provider",
              type: "function",
              function: { name: "web_search", arguments: "{}" },
              ...(onCall ? { metadata } : {}),
            },
          ],
        },
        {
          id: "p",
          role: "tool",
          toolCallId: "provider",
          content: "provider output",
          ...(!onCall ? { metadata } : {}),
        },
        { id: "c", role: "tool", toolCallId: "client", content },
      ],
    } as RunAgentInput

    const result = fromRunAgentInput(input)

    expect(result.messages).toEqual([
      { id: "u", role: "user", content: "hello" },
      { id: "a", role: "assistant", content: "answer" },
      { id: "c", role: "tool", toolCallId: "client", content },
    ])
    expect(result.raw).toBe(input)
    expect(input.messages).toHaveLength(4)
  })
}
