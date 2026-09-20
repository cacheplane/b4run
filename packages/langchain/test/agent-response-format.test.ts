import { agent } from "@b4run/sdk"
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetMaterializedAgentsForTests, streamAgent } from "../src/agent-adapter.ts"
import type { JsonSchemaResponseFormat } from "../src/chat-model-factory.ts"

/**
 * Every call option the fake model saw, per turn, in order. Filled by the
 * real `createReactAgent` graph the adapter compiles: the first turn answers
 * with a tool call, the second with the final message — so this is the
 * observation the issue asks for: the format rides along BOTH turns (the
 * model loop only ever binds it once) and the tool-calling turn is otherwise
 * untouched.
 */
const seenCallOptions: Array<Record<string, unknown>> = []

/**
 * A `ChatOpenAI` stand-in that behaves like a LangChain chat model: `bindTools`
 * is the real `withConfig` route, so the adapter's own `withConfig` binding
 * and the graph's tool binding must merge for the format to reach `_generate`.
 */
class RecordingChatModel extends BaseChatModel {
  private turn = 0
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  _llmType(): string {
    return "recording-fake"
  }
  async _generate(_messages: BaseMessage[], options: Record<string, unknown>): Promise<ChatResult> {
    seenCallOptions.push(options)
    this.turn += 1
    const message =
      this.turn === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "call_1", name: "lookup", args: { q: "x" }, type: "tool_call" }],
          })
        : new AIMessage({ content: '{"ui":[]}' })
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }],
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(tools: any): any {
    // `tools` is a provider call option, not a base-model one; the real
    // `ChatOpenAI.bindTools` does exactly this cast internally.
    return this.withConfig({ tools } as unknown as Partial<BaseChatModelCallOptions>)
  }
}

const responseFormat: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "hashbrown_response",
  schema: {
    type: "object",
    properties: { ui: { type: "array", items: { type: "string" } } },
    required: ["ui"],
    additionalProperties: false,
  },
}

const lookupTool = {
  name: "lookup",
  description: "Look something up.",
  schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  run: async () => "found",
}

async function runTurn(options: {
  readonly responseFormat?: JsonSchemaResponseFormat
  readonly checkpointer?: MemorySaver
  readonly entry?: ReturnType<typeof agent>
}) {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: RecordingChatModel }))
  try {
    let done: unknown
    for await (const chunk of streamAgent({
      checkpointer: options.checkpointer ?? new MemorySaver(),
      entry: options.entry ?? agent({ model: "gpt-5-mini", systemPrompt: "Answer as JSON." }),
      input: { messages: [{ role: "user", content: "go" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: `t-${Math.random()}`,
      tools: [lookupTool],
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    })) {
      if (chunk.type === "done") done = chunk.data
    }
    // The fake does not stream, so the reply is read off the graph's final
    // state rather than off token chunks.
    const messages = (done as { messages?: ReadonlyArray<{ content: unknown }> }).messages ?? []
    return messages.at(-1)?.content
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

describe("root model response format", () => {
  afterEach(() => {
    seenCallOptions.length = 0
    __resetMaterializedAgentsForTests()
  })

  it("binds the JSON-schema response format on every root-model invocation, tools intact", async () => {
    const text = await runTurn({ responseFormat })

    expect(text).toBe('{"ui":[]}')
    expect(seenCallOptions).toHaveLength(2)
    for (const options of seenCallOptions) {
      expect(options.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "hashbrown_response", schema: responseFormat.schema, strict: true },
      })
      const tools = options.tools as ReadonlyArray<{ readonly name?: string }>
      expect(tools.map((tool) => tool.name)).toEqual(["lookup"])
    }
  })

  it("leaves the invocation options alone when no response format is supplied", async () => {
    const text = await runTurn({})

    expect(text).toBe('{"ui":[]}')
    expect(seenCallOptions).toHaveLength(2)
    for (const options of seenCallOptions) {
      expect(options).not.toHaveProperty("response_format")
    }
  })

  it("never serves a format-bound graph from the shared cache, nor seeds it", async () => {
    // One descriptor and one checkpointer, so the compiled-graph cache CAN hit:
    // turn 1 seeds it, turn 2 (format-bound) must bypass it, and turn 3 must
    // get turn 1's unbound graph back — not turn 2's.
    const entry = agent({ model: "gpt-5-mini", systemPrompt: "Answer as JSON." })
    const checkpointer = new MemorySaver()
    await runTurn({ entry, checkpointer })
    await runTurn({ entry, checkpointer, responseFormat })
    const before = seenCallOptions.length
    await runTurn({ entry, checkpointer })

    const thirdTurn = seenCallOptions.slice(before)
    expect(thirdTurn.length).toBeGreaterThan(0)
    for (const options of thirdTurn) expect(options).not.toHaveProperty("response_format")
    // And turn 2 really was bound.
    expect(seenCallOptions.slice(2, before).every((o) => "response_format" in o)).toBe(true)
  })
})
