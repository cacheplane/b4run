import { agent } from "@b4run/sdk"
import { AIMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { expect, test, vi } from "vitest"
import { materializeAgentGraph } from "../src/agent-adapter.ts"
import { createChatModel, seedModelImporter } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

class InspectableOpenAI extends ChatOpenAI {
  readonly requestModel = this.responses
}

// Observe the call options at the installed provider's request conversion boundary.
test("standalone built-ins reach actual OpenAI invocation request parameters", async () => {
  const requests: unknown[] = []
  const responses = new InspectableOpenAI({ apiKey: "test-unused" }).requestModel
  vi.spyOn(responses, "_generate").mockImplementation(async (_messages, options) => {
    requests.push(responses.invocationParams(options))
    return { generations: [{ text: "done", message: new AIMessage("done") }] }
  })
  class OfflineOpenAI extends ChatOpenAI {
    constructor(options: Record<string, unknown>) {
      super({ ...options, apiKey: "test-unused", responses })
    }
  }
  const model = (await createChatModel({
    model: "gpt-5-mini",
    provider: "openai",
    builtInTools: { openai: { webSearch: true, codeExecution: true } },
    importer: async () => ({ ChatOpenAI: OfflineOpenAI }),
  })) as ChatOpenAI

  await model.invoke("Search and compute")

  expect(requests).toEqual([
    expect.objectContaining({
      tools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }],
      include: ["web_search_call.action.sources", "code_interpreter_call.outputs"],
    }),
  ])
})

test("createAgent binds native and application tools once and preserves include and response schema", async () => {
  const binds: unknown[][] = []
  const requests: unknown[] = []
  const handler = vi.fn(() => "local")
  const responses = new InspectableOpenAI({ apiKey: "test-unused" }).requestModel
  vi.spyOn(responses, "_generate").mockImplementation(async (_messages, options) => {
    requests.push(responses.invocationParams(options))
    return { generations: [{ text: '{"ok":true}', message: new AIMessage('{"ok":true}') }] }
  })
  const originalBind = ChatOpenAI.prototype.bindTools
  const bindSpy = vi.spyOn(ChatOpenAI.prototype, "bindTools").mockImplementation(function (
    this: ChatOpenAI,
    tools,
    options,
  ) {
    binds.push(tools)
    return originalBind.call(this, tools, options)
  })
  class OfflineOpenAI extends ChatOpenAI {
    constructor(options: Record<string, unknown>) {
      super({ ...options, apiKey: "test-unused", responses })
    }
  }
  seedModelImporter(async () => ({ ChatOpenAI: OfflineOpenAI }))
  try {
    const descriptor = agent({
      model: "gpt-5-mini",
      systemPrompt: "Help",
      builtInTools: { openai: { webSearch: true } },
    })
    const local = { name: "local", description: "Local tool", run: handler }
    const graph = await materializeAgentGraph({
      descriptor,
      tools: [local],
      responseFormat: {
        type: "json_schema",
        name: "answer",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    })

    await (graph as { invoke(input: unknown): Promise<unknown> }).invoke({
      messages: [{ role: "user", content: "Search" }],
    })

    expect(binds).toHaveLength(1)
    expect(binds[0]).toHaveLength(2)
    expect(binds[0]).toEqual(
      expect.arrayContaining([{ type: "web_search" }, expect.objectContaining({ name: "local" })]),
    )
    expect(requests).toEqual([
      expect.objectContaining({
        include: ["web_search_call.action.sources"],
        tools: expect.arrayContaining([
          { type: "web_search" },
          expect.objectContaining({ type: "function", name: "local" }),
        ]),
        text: expect.objectContaining({
          format: expect.objectContaining({ type: "json_schema", name: "answer" }),
        }),
      }),
    ])
    expect(handler).not.toHaveBeenCalled()
  } finally {
    bindSpy.mockRestore()
    seedModelImporter(defaultModelImporter)
  }
})
