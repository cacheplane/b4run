import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { Command, interrupt, MemorySaver } from "@langchain/langgraph"
import { expect, test, vi } from "vitest"
import { __resetMaterializedAgentsForTests, executeAgentTurn } from "../src/agent-adapter.ts"

test("resumed tools receive the new middleware context while retaining their pending checkpoint", async () => {
  const responses = [
    new AIMessage({ content: "", tool_calls: [{ name: "approve", args: {}, id: "approval-1" }] }),
    new AIMessage({ content: "Applied." }),
  ]
  const prompts: BaseMessage[][] = []
  const observed: unknown[] = []
  let cursor = 0
  class ScriptedChatModel extends BaseChatModel {
    constructor() {
      super({})
    }
    _llmType(): string {
      return "scripted-middleware-resume"
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      prompts.push(messages)
      const message = responses[cursor++]
      if (!message) throw new Error("Unexpected extra model request")
      return { generations: [{ text: String(message.content), message }] }
    }
    bindTools() {
      return this
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedChatModel }))
  __resetMaterializedAgentsForTests()
  const base = {
    entry: agent({ model: "gpt-5-mini", systemPrompt: "Ask before applying." }),
    checkpointer: new MemorySaver(),
    threadId: "middleware-resume",
    routeParamNames: [],
    signal: new AbortController().signal,
    tools: [
      {
        name: "approve",
        run: async (
          _input: unknown,
          context: { readonly middleware?: Readonly<Record<string, unknown>> },
        ) => {
          const decision = interrupt({ question: "Apply?" })
          observed.push(context.middleware)
          return `Decision: ${decision}; request: ${context.middleware?.requestId}`
        },
      },
    ],
  }

  try {
    const first = await executeAgentTurn({
      ...base,
      input: { messages: [{ role: "user", content: "Apply the change" }] },
      middlewareContext: { requestId: "initial", authorized: false },
    })
    expect(first.parked).toBe(true)
    expect(observed).toEqual([])
    const resumed = await executeAgentTurn({
      ...base,
      input: new Command({ resume: "once" }),
      middlewareContext: { requestId: "resumed", authorized: true },
    })

    expect(resumed.parked).toBe(false)
    expect(observed).toEqual([{ requestId: "resumed", authorized: true }])
    expect(cursor).toBe(2)
    expect(JSON.stringify(prompts.at(-1))).toContain("Apply the change")
    expect(JSON.stringify(prompts.at(-1))).toContain("Decision: once; request: resumed")
  } finally {
    vi.doUnmock("@langchain/openai")
    __resetMaterializedAgentsForTests()
  }
})
