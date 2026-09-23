/**
 * Real-graph pins for what B4's `createAgent` middleware took over from
 * `createReactAgent`: prompt fragments rendered from live route state, route
 * state reducers applied exactly once, and summarization's condensed view.
 */

import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, test, vi } from "vitest"
import { __resetMaterializedAgentsForTests, streamAgent } from "../src/agent-adapter.ts"
import type { ResolvedStateField } from "../src/state-adapter.ts"
import type { ResolvedSummarizationConfig } from "../src/summarization/index.ts"

let script: AIMessage[] = []
/** What the model received on each call, as `type:content` lines. */
let seen: string[][] = []

class ScriptedChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seen.push(
      messages.map(
        (m) =>
          `${m.getType()}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
      ),
    )
    const message = script[seen.length - 1]
    if (!message) throw new Error("ScriptedChatModel ran out of canned responses")
    return { generations: [{ text: "", message }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

const callTool = (id: string, name: string) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args: {}, type: "tool_call" }] })

/** Appends one entry to the `notes` state field. */
const noteTool = {
  name: "note",
  description: "Record a note.",
  schema: { type: "object", properties: {} },
  run: async () => ({ result: "noted", state: { notes: "n" } }),
}

const notesField: ResolvedStateField = { name: "notes", reducer: "append", default: [] }

async function runTurn(options: {
  readonly tools?: readonly object[]
  readonly stateFields?: readonly ResolvedStateField[]
  readonly promptFragments?: Parameters<typeof streamAgent>[0]["promptFragments"]
  readonly summarization?: ResolvedSummarizationConfig
  readonly checkpointer?: MemorySaver
  readonly threadId?: string
  readonly message?: string
}) {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedChatModel }))
  try {
    let done: Record<string, unknown> | undefined
    for await (const chunk of streamAgent({
      checkpointer: options.checkpointer ?? new MemorySaver(),
      entry: agent({ model: "gpt-5-mini", systemPrompt: "Base prompt." }),
      input: { messages: [{ role: "user", content: options.message ?? "go" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: options.threadId ?? `mw-${Math.random()}`,
      tools: (options.tools ?? []) as Parameters<typeof streamAgent>[0]["tools"],
      ...(options.stateFields ? { stateFields: options.stateFields } : {}),
      ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
      ...(options.summarization ? { summarization: options.summarization } : {}),
    })) {
      if (chunk.type === "done") done = chunk.data as Record<string, unknown>
    }
    return done ?? {}
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

afterEach(() => {
  script = []
  seen = []
  __resetMaterializedAgentsForTests()
})

test("prompt fragments render from the route's live state on every model turn", async () => {
  script = [callTool("call_1", "note"), new AIMessage("done")]

  await runTurn({
    tools: [noteTool],
    stateFields: [notesField],
    promptFragments: [
      {
        placement: "after_user_prompt",
        render: (state) => `Notes: ${JSON.stringify(state.notes ?? [])}`,
      },
    ],
  })

  expect(seen.map((messages) => messages[0])).toEqual([
    "system:Base prompt.\n\nNotes: []",
    'system:Base prompt.\n\nNotes: ["n"]',
  ])
})

test("an append field is applied once per update when the loop-entry middleware runs", async () => {
  // A returnDirect tool installs the loop-entry `beforeModel` node, which
  // writes its declared fields back on every update; the route's own fields
  // must not be among them or `append` would re-append the whole list.
  script = [callTool("call_1", "note"), callTool("call_2", "note"), new AIMessage("done")]
  const finish = { ...noteTool, name: "finish", returnDirect: true }

  const output = await runTurn({ tools: [noteTool, finish], stateFields: [notesField] })

  expect(output.notes).toEqual(["n", "n"])
})

test("summarization sends the model the condensed view and keeps the running summary", async () => {
  const summarization: ResolvedSummarizationConfig = {
    maxTokens: 1,
    keepRecentTurns: 1,
    model: "gpt-5-mini",
    tokenCounter: (text) => text.length,
    summarize: async ({ messages }) => `summary of ${messages.length}`,
  }
  const checkpointer = new MemorySaver()
  const threadId = `summary-${Math.random()}`
  script = [new AIMessage("first answer"), new AIMessage("second answer")]

  await runTurn({ summarization, checkpointer, threadId, message: "first question" })
  const output = await runTurn({
    summarization,
    checkpointer,
    threadId,
    message: "second question",
  })

  // Turn two: the first exchange is folded into the summary, the recent turn
  // is sent verbatim, and the full history stays in state.
  expect(seen[1]).toEqual([
    "system:Base prompt.",
    "system:Summary of earlier conversation:\nsummary of 2",
    "human:second question",
  ])
  expect(output.runningSummary).toEqual({ summary: "summary of 2", coveredCount: 2 })
  expect((output.messages as BaseMessage[]).map((m) => String(m.content))).toEqual([
    "first question",
    "first answer",
    "second question",
    "second answer",
  ])
})
