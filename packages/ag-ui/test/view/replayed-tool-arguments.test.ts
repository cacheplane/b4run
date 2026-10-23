import { expect, test } from "vitest"
import { toAguiEvents } from "../../src/outbound.ts"
import type { B4AgentStreamChunk } from "../../src/types.ts"
import { EMPTY_TURNS, reduceTurns } from "../../src/view/turns.ts"

test("the turn view keeps checkpointed arguments when a resumed call has no new deltas", async () => {
  const paused: readonly B4AgentStreamChunk[] = [
    {
      type: "tool_call",
      data: { id: "call", name: "runBash", input: { command: "node x" }, messageId: "model" },
    },
    {
      type: "interrupt",
      data: {
        interruptId: "permission",
        type: "permission-request",
        kind: "command",
        toolCallId: "call",
        detail: { command: "node x" },
      },
    },
  ]
  const resumed: readonly B4AgentStreamChunk[] = [
    {
      type: "tool_call",
      data: { id: "call", name: "runBash", input: { command: "node x" }, replayed: true },
    },
    { type: "tool_result", data: { id: "call", name: "runBash", output: "ran" } },
    { type: "done" },
  ]
  let view = EMPTY_TURNS

  for (const [index, chunks] of [paused, resumed].entries()) {
    for await (const event of toAguiEvents(
      (async function* () {
        yield* chunks
      })(),
      { threadId: "thread", runId: `run-${index}` },
    )) {
      view = reduceTurns(view, event)
    }
  }

  expect(view.turns).toHaveLength(1)
  expect(view.turns[0]?.steps[0]).toMatchObject({
    args: '{"command":"node x"}',
    status: "done",
    result: "ran",
  })
})
