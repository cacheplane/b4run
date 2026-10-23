import { EventType } from "@ag-ui/core"
import { expect, test } from "vitest"
import { toAguiEvents } from "../src/outbound.ts"
import type { B4AgentStreamChunk } from "../src/types.ts"

async function events(chunks: readonly B4AgentStreamChunk[], runId: string) {
  const result = []
  for await (const event of toAguiEvents(
    (async function* () {
      yield* chunks
    })(),
    { threadId: "thread", runId },
  )) {
    result.push(event)
  }
  return result
}

test("a replay without its originating model never invents a different tool parent", async () => {
  const first = await events(
    [
      {
        type: "tool_call",
        data: { id: "find", name: "findAircraft", input: {}, messageId: "model" },
      },
      { type: "done" },
    ],
    "first",
  )

  const resumed = await events(
    [
      { type: "tool_call", data: { id: "find", name: "findAircraft", input: {}, replayed: true } },
      { type: "tool_result", data: { id: "find", name: "findAircraft", output: "found" } },
      {
        type: "tool_call",
        data: { id: "highlight", name: "highlightAircraft", input: {}, messageId: "next-model" },
      },
      { type: "done" },
    ],
    "resumed",
  )

  const initial = first.find((event) => event.type === EventType.TOOL_CALL_START)
  const replay = resumed.find(
    (event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "find",
  )
  const next = resumed.find(
    (event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "highlight",
  )
  expect(initial?.parentMessageId).toEqual(expect.any(String))
  expect(replay).not.toHaveProperty("parentMessageId")
  expect(
    resumed.filter(
      (event) => event.type === EventType.TOOL_CALL_ARGS && event.toolCallId === "find",
    ),
  ).toEqual([])
  expect(next).toMatchObject({ parentMessageId: expect.any(String) })
  expect(
    resumed.some(
      (event) => event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === "find",
    ),
  ).toBe(true)
})
