/**
 * Real-graph pin for `returnDirect`: a tool that ends the run must not be
 * followed by another model turn. LangGraph's prebuilt agent routes the
 * tools node back to the model unconditionally unless a tool carries
 * `returnDirect`, in which case its result ends the graph; the converter is
 * what has to carry the flag across.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage, isToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import { expect, test } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

class SequencedChatModel extends BaseChatModel {
  calls = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "sequenced-fake"
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const msg = this.responses[this.calls]
    this.calls += 1
    if (!msg) throw new Error("SequencedChatModel ran out of canned responses")
    return { generations: [{ text: "", message: msg }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

function graphWith(returnDirect: boolean, model: SequencedChatModel) {
  const render = convertToolToLangChain({
    name: "render",
    ...(returnDirect ? { returnDirect: true } : {}),
    run: async () => ({ rendered: true }),
  })
  return createReactAgent({
    llm: model,
    tools: [render],
    checkpointer: new MemorySaver(),
    // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
  } as any)
}

const callsRender = () =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: "call_render_1", name: "render", args: {}, type: "tool_call" }],
  })

async function run(graph: object) {
  const runnable = graph as {
    invoke: (
      input: unknown,
      options: Record<string, unknown>,
    ) => Promise<{ messages: BaseMessage[] }>
  }
  return runnable.invoke(
    { messages: [{ role: "user", content: "go" }] },
    { configurable: { thread_id: "return-direct" } },
  )
}

test("a returnDirect tool ends the run on its result with exactly one model turn", async () => {
  const model = new SequencedChatModel([callsRender()])

  const output = await run(graphWith(true, model))

  expect(model.calls).toBe(1)
  const last = output.messages.at(-1)
  expect(last !== undefined && isToolMessage(last)).toBe(true)
  expect(String(last?.content)).toBe(JSON.stringify({ rendered: true }))
})

test("without returnDirect the same graph hands control back to the model", async () => {
  const model = new SequencedChatModel([callsRender()])

  await expect(run(graphWith(false, model))).rejects.toThrow("ran out of canned responses")
  expect(model.calls).toBe(2)
})
