import { emitToolStep } from "@b4run/langgraph/ui"
import { ToolMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"

/** Run approved work in a graph node and return a message to append to state.messages. */
export async function lookupWithSteps(config: RunnableConfig, toolCallId: string) {
  const running = { v: 1, kind: "server", status: "running", startedAt: Date.now() } as const
  await emitToolStep(config, { ...running, toolCallId })
  const content = "Found record"
  const step = { ...running, status: "completed", settledAt: Date.now(), label: content } as const
  await emitToolStep(config, { ...step, toolCallId })
  return new ToolMessage({
    content,
    tool_call_id: toolCallId,
    additional_kwargs: { b4_step: step },
  })
}
