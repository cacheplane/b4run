/**
 * Real-graph pin for `returnDirect`, through B4's own materialized agent: a
 * tool that ends the run must not be followed by another model turn when it
 * SUCCEEDS, and a failed call (the tool threw, or the model's arguments failed
 * its schema) must go back to the model so it can correct the call and retry.
 * LangGraph's and LangChain's prebuilt routers end the run on the tool's name
 * alone, error or not; B4 routes these itself (`endsOnReturnDirect`).
 */

import { wrapToolWithApproval } from "@b4run/core"
import { agent, B4_STEP_KEY } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage, isAIMessage, isToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, test, vi } from "vitest"
import {
  __resetMaterializedAgentsForTests,
  type AgentStreamChunk,
  streamAgent,
} from "../src/agent-adapter.ts"

let script: AIMessage[] = []
let modelCalls = 0
/** What each model call was shown, in order. */
let seenByModel: BaseMessage[][] = []

class ScriptedChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seenByModel.push(messages)
    const message = script[modelCalls]
    modelCalls += 1
    if (!message) throw new Error("ScriptedChatModel ran out of canned responses")
    return { generations: [{ text: "", message }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

const callsRender = (id: string, ui: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "render", args: { ui }, type: "tool_call" }],
  })

const renderSchema = {
  type: "object",
  properties: { ui: { type: "string", enum: ["Table", "Chart"] } },
  required: ["ui"],
}

function renderTool(options: {
  readonly returnDirect: boolean
  readonly run?: (input: { readonly ui: string }) => unknown
}) {
  return {
    name: "render",
    description: "Render the UI. Call exactly once, last.",
    schema: renderSchema,
    ...(options.returnDirect ? { returnDirect: true } : {}),
    run: async (input: unknown) =>
      options.run
        ? options.run(input as { ui: string })
        : { rendered: (input as { ui: string }).ui },
  }
}

async function runTurn(tools: readonly ReturnType<typeof renderTool>[]) {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedChatModel }))
  try {
    const chunks: AgentStreamChunk[] = []
    let done: { messages: BaseMessage[] } | undefined
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: agent({ model: "gpt-5-mini", systemPrompt: "Render the answer." }),
      input: { messages: [{ role: "user", content: "show the invoice" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: `return-direct-${Math.random()}`,
      tools,
    })) {
      chunks.push(chunk)
      if (chunk.type === "done") done = chunk.data as { messages: BaseMessage[] }
    }
    const messages = done?.messages ?? []
    return {
      chunks,
      messages,
      toolStatuses: messages.filter(isToolMessage).map((m) => m.status),
    }
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

afterEach(() => {
  script = []
  modelCalls = 0
  seenByModel = []
  __resetMaterializedAgentsForTests()
})

test("a returnDirect tool ends the run on its successful result with exactly one model turn", async () => {
  script = [callsRender("call_1", "Table")]

  const { messages } = await runTurn([renderTool({ returnDirect: true })])

  expect(modelCalls).toBe(1)
  const last = messages.at(-1)
  expect(last !== undefined && isToolMessage(last)).toBe(true)
  expect(String(last?.content)).toBe(JSON.stringify({ rendered: "Table" }))
})

test("a returnDirect tool that throws goes back to the model, and the successful retry ends the run", async () => {
  script = [callsRender("call_1", "Table"), callsRender("call_2", "Chart")]
  let attempts = 0
  const render = renderTool({
    returnDirect: true,
    run: (input) => {
      attempts += 1
      if (attempts === 1) throw new Error("invalid_ui: rejected")
      return { rendered: input.ui }
    },
  })

  const { chunks, messages, toolStatuses } = await runTurn([render])

  expect(modelCalls).toBe(2)
  expect(toolStatuses).toEqual(["error", "success"])
  const failed = messages.filter(isToolMessage)[0]
  expect(failed?.content).toBe("Error: invalid_ui: rejected\n Please fix your mistakes.")
  const last = messages.at(-1)
  expect(last !== undefined && isToolMessage(last)).toBe(true)
  expect(String(last?.content)).toBe(JSON.stringify({ rendered: "Chart" }))
  // The client sees both calls resolve, the failed one first.
  expect(
    chunks.filter((c) => c.type === "tool_result").map((c) => (c.data as { id: string }).id),
  ).toEqual(["call_1", "call_2"])
})

test("arguments that fail a returnDirect tool's schema go back to the model", async () => {
  script = [callsRender("call_1", "Tabel"), callsRender("call_2", "Table")]

  const { messages, toolStatuses } = await runTurn([renderTool({ returnDirect: true })])

  expect(modelCalls).toBe(2)
  expect(toolStatuses).toEqual(["error", "success"])
  expect(String(messages.at(-1)?.content)).toBe(JSON.stringify({ rendered: "Table" }))
})

test("without returnDirect the same tool hands control back to the model", async () => {
  script = [callsRender("call_1", "Table"), new AIMessage("Here is your invoice.")]

  const { messages } = await runTurn([renderTool({ returnDirect: false })])

  expect(modelCalls).toBe(2)
  const last = messages.at(-1)
  expect(last !== undefined && isAIMessage(last)).toBe(true)
  expect(last?.content).toBe("Here is your invoice.")
})

test("a denied returnDirect call goes back to the model instead of ending the run", async () => {
  // On main the denial text ended the run as the final answer. The denial is
  // now a `status: "error"` ToolMessage, and `endsOnReturnDirect` ends only
  // on success, so the model reads the denial like any failed call.
  script = [callsRender("call_1", "Table"), new AIMessage("I am not allowed to render that.")]
  const deniesEverything = {
    mode: "interactive" as const,
    match: () => "deny" as const,
    load: async () => {},
    addAllow: async () => {},
  }
  const render = wrapToolWithApproval(renderTool({ returnDirect: true }), deniesEverything)

  const { messages, toolStatuses } = await runTurn([render])

  expect(modelCalls).toBe(2)
  expect(toolStatuses).toEqual(["error"])
  const denial = messages.filter(isToolMessage)[0]
  expect(denial?.content).toBe("[B4_E3001] Permission denied by user: tool render")
  expect(denial?.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed" })
  // The second model call was shown the denial ToolMessage.
  const shown = seenByModel[1]?.filter(isToolMessage) ?? []
  expect(shown.map((m) => [m.tool_call_id, m.status, String(m.content)])).toEqual([
    ["call_1", "error", "[B4_E3001] Permission denied by user: tool render"],
  ])
  const last = messages.at(-1)
  expect(last !== undefined && isAIMessage(last)).toBe(true)
  expect(last?.content).toBe("I am not allowed to render that.")
})
