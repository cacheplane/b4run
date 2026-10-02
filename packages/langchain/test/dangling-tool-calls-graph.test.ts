/**
 * Real-graph pin for a thread whose last run was cut off between a model turn
 * and its tool calls (here by `recursionLimit`; an abort or a crash does the
 * same). The checkpoint keeps the assistant message with `tool_calls` and no
 * tool results, and providers refuse that history: OpenAI answers 400 "An
 * assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'". Without a repair, every later turn on
 * the thread fails.
 */

import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import {
  AIMessage,
  type BaseMessage,
  isAIMessage,
  isToolMessage,
  type ToolMessage,
} from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, test, vi } from "vitest"
import { __resetMaterializedAgentsForTests, streamAgent } from "../src/agent-adapter.ts"

let script: AIMessage[] = []
let seen: BaseMessage[][] = []

/** Every tool call must be answered before the next message, as OpenAI requires. */
function assertAnswered(messages: readonly BaseMessage[]) {
  messages.forEach((message, index) => {
    if (!isAIMessage(message)) return
    for (const call of message.tool_calls ?? []) {
      const answered = messages
        .slice(index + 1)
        .findIndex((m) => !isToolMessage(m) || m.tool_call_id === call.id)
      const answer = answered === -1 ? undefined : messages[index + 1 + answered]
      if (!answer || !isToolMessage(answer))
        throw new Error(
          `400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${call.id}`,
        )
    }
  })
}

class StrictScriptedChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  _llmType(): string {
    return "strict-scripted-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seen.push(messages)
    assertAnswered(messages)
    const message = script[seen.length - 1]
    if (!message) throw new Error("StrictScriptedChatModel ran out of canned responses")
    return { generations: [{ text: "", message }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

const lookup = {
  name: "lookup",
  description: "Look a record up.",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (input: unknown) => ({ found: (input as { id: string }).id }),
}

async function turn(options: {
  readonly checkpointer: MemorySaver
  readonly threadId: string
  readonly content: string
  readonly recursionLimit?: number
}) {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: StrictScriptedChatModel }))
  try {
    let done: { messages: BaseMessage[] } | undefined
    for await (const chunk of streamAgent({
      checkpointer: options.checkpointer,
      entry: agent({
        model: "gpt-5-mini",
        systemPrompt: "Look things up.",
        ...(options.recursionLimit !== undefined ? { recursionLimit: options.recursionLimit } : {}),
      }),
      input: { messages: [{ role: "user", content: options.content }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: options.threadId,
      tools: [lookup],
    }))
      if (chunk.type === "done") done = chunk.data as { messages: BaseMessage[] }
    return done
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

afterEach(() => {
  script = []
  seen = []
  __resetMaterializedAgentsForTests()
})

test("a turn after a run cut off before its tool calls ran still reaches the model", async () => {
  const checkpointer = new MemorySaver()
  const threadId = `dangling-${Math.random()}`
  script = [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_cut", name: "lookup", args: { id: "a" }, type: "tool_call" }],
    }),
    new AIMessage({ content: "Here is the answer." }),
  ]
  // One superstep: the model turn runs and is checkpointed, the tools never do.
  await expect(
    turn({ checkpointer, threadId, content: "look a up", recursionLimit: 1 }),
  ).rejects.toThrow(/Recursion limit/)

  const done = await turn({ checkpointer, threadId, content: "and now?" })

  expect(String(done?.messages.at(-1)?.content)).toBe("Here is the answer.")
  const sent = seen[1] ?? []
  const cut = sent.findIndex((m) => isAIMessage(m) && m.tool_calls?.[0]?.id === "call_cut")
  const answer = sent[cut + 1] as ToolMessage | undefined
  expect(answer !== undefined && isToolMessage(answer)).toBe(true)
  expect(answer?.tool_call_id).toBe("call_cut")
  expect(answer?.status).toBe("error")
})
