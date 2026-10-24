import { readFileSync, writeFileSync } from "node:fs"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage, isToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { Command, interrupt, MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { expect, test, vi } from "vitest"
import { toolStepMiddleware } from "../src/ui.ts"

/** Deterministic model: asks for fixed tool calls once, then answers. */
class ScriptedModel extends BaseChatModel {
  constructor(readonly calls: { name: string; id: string; args: Record<string, unknown> }[]) {
    super({})
  }
  _llmType() {
    return "tool-step-test"
  }
  bindTools() {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = messages.some(isToolMessage)
      ? new AIMessage("finished")
      : new AIMessage({ content: "", tool_calls: this.calls })
    return { generations: [{ text: "", message }] }
  }
}
const schema = { type: "object", properties: {}, additionalProperties: false } as const
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

test("real agent emits running before blocked tool work and isolates parallel calls", async () => {
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const values: Record<string, unknown>[] = []
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const lookup = tool(
    async (_args, config) => {
      entered()
      await blocked
      return config.toolCall?.id ?? "ok"
    },
    { name: "lookup", description: "lookup", schema },
  )
  const agent = createAgent({
    model: new ScriptedModel([
      { name: "lookup", id: "a", args: {} },
      { name: "lookup", id: "b", args: {} },
    ]),
    tools: [lookup],
    middleware: [toolStepMiddleware()],
  })
  const callbacks = [
    {
      name: "steps",
      awaitHandlers: true,
      handleCustomEvent(_name: string, value: Record<string, unknown>) {
        values.push(value)
      },
    },
  ]

  const pending = agent.invoke({ messages: [{ role: "user", content: "go" }] }, { callbacks })
  await started
  expect(values.some((value) => value.status === "completed")).toBe(false)
  expect(values.some((value) => value.status === "running")).toBe(true)
  release()
  const result = await pending

  expect(
    values
      .filter((value) => value.status === "running")
      .map((value) => value.toolCallId)
      .sort(),
  ).toEqual(["a", "b"])
  expect(
    values
      .filter((value) => value.status === "completed")
      .map((value) => value.toolCallId)
      .sort(),
  ).toEqual(["a", "b"])
  expect(
    result.messages.filter(isToolMessage).map((message) => message.additional_kwargs.b4_step),
  ).toMatchObject([{ status: "completed" }, { status: "completed" }])
})

test("real interrupt checkpoints no result and resumes to a settled ToolMessage", async () => {
  const checkpointer = new MemorySaver()
  const approval = tool(
    async () => {
      const value = interrupt("approve")
      return String(value)
    },
    { name: "approval", description: "approval", schema },
  )
  const agent = createAgent({
    model: new ScriptedModel([{ name: "approval", id: "approval-call", args: {} }]),
    tools: [approval],
    middleware: [toolStepMiddleware()],
    checkpointer,
  })
  const config = { configurable: { thread_id: "interrupt-test" } }

  const paused = await agent.invoke({ messages: [{ role: "user", content: "go" }] }, config)
  const before = (await agent.getState(config)) as unknown as {
    values: { messages: BaseMessage[] }
  }
  const resumed = await agent.invoke(new Command({ resume: "approved" }), config)

  expect(paused.messages.filter(isToolMessage)).toEqual([])
  expect(
    JSON.parse(JSON.stringify(before.values)).messages.filter(
      (message: { type: string }) => message.type === "tool",
    ),
  ).toEqual([])
  expect(resumed.messages.filter(isToolMessage)).toMatchObject([
    { content: "approved", additional_kwargs: { b4_step: { status: "completed" } } },
  ])
})

test("outer approval denial does not start tool execution", async () => {
  const executed = vi.fn(async () => "unexpected")
  const lookup = tool(executed, { name: "lookup", description: "lookup", schema })
  const gate = createMiddleware({
    name: "deny",
    wrapToolCall: async (request) => {
      const { ToolMessage } = await import("@langchain/core/messages")
      return new ToolMessage({
        content: "denied",
        tool_call_id: request.toolCall.id ?? "",
        additional_kwargs: { b4_step: { v: 1, kind: "server", status: "denied" } },
      })
    },
  })
  const agent = createAgent({
    model: new ScriptedModel([{ name: "lookup", id: "denied", args: {} }]),
    tools: [lookup],
    middleware: [gate, toolStepMiddleware()],
  })

  const events = await collect(
    agent.streamEvents({ messages: [{ role: "user", content: "go" }] }, { version: "v2" }),
  )

  expect(executed).not.toHaveBeenCalled()
  expect(events.filter((event) => event.event === "on_custom_event")).toEqual([])
})

/** Produce only stable wire/checkpoint fields from actual helper output. */
async function goldenFixture() {
  const lookup = tool(async () => "found", { name: "lookup", description: "lookup", schema })
  const broken = tool(
    async () => {
      throw Object.assign(new Error("upstream offline"), { code: "OFFLINE" })
    },
    { name: "broken", description: "broken", schema },
  )
  const checkpointer = new MemorySaver()
  const agent = createAgent({
    model: new ScriptedModel([
      { name: "lookup", id: "call-success", args: {} },
      { name: "broken", id: "call-failure", args: {} },
    ]),
    tools: [lookup, broken],
    middleware: [
      toolStepMiddleware({
        display: {
          lookup: {
            running: () => "Looking up",
            done: () => "Found result",
            sources: () => [
              { id: "source-1", kind: "url", title: "Example", href: "https://example.com" },
            ],
          },
        },
      }),
    ],
    checkpointer,
  })
  const config = { configurable: { thread_id: "golden" } }
  const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000000)
  try {
    const events = await collect(
      agent.streamEvents(
        { messages: [{ role: "user", content: "go" }] },
        { ...config, version: "v2" },
      ),
    )
    const snapshot = (await agent.getState(config)) as unknown as {
      values: { messages: BaseMessage[] }
    }
    const messages = (snapshot.values as { messages: BaseMessage[] }).messages.filter(isToolMessage)
    const custom = events
      .filter((event) => event.event === "on_custom_event" && event.name === "b4.step")
      .map((event) => ({ type: "CUSTOM", name: event.name, value: event.data }))
    const standard = messages.flatMap((message) => [
      {
        type: "TOOL_CALL_START",
        toolCallId: message.tool_call_id,
        toolCallName: message.name,
        parentMessageId: "assistant-1",
      },
      { type: "TOOL_CALL_ARGS", toolCallId: message.tool_call_id, delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: message.tool_call_id },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `result-${message.tool_call_id}`,
        toolCallId: message.tool_call_id,
        content: message.content,
        role: "tool",
      },
    ])
    const restored = messages.map((message) => ({
      id: `result-${message.tool_call_id}`,
      role: "tool",
      toolCallId: message.tool_call_id,
      content: message.content,
      metadata: { "b4.step": message.additional_kwargs.b4_step },
      ...(message.status === "error"
        ? {
            error: (message.additional_kwargs.b4_step as { error: { message: string } }).error
              .message,
          }
        : {}),
    }))
    return JSON.parse(
      JSON.stringify({
        provenance:
          "Generated by tool-step-agent.test.ts from real createAgent streamEvents v2 and MemorySaver checkpoint; standard frames assembled from actual ToolMessages, deliberately delivered after CUSTOM to cover unstreamed late START.",
        events: [...custom, ...standard],
        persisted: messages.map((message) => ({
          tool_call_id: message.tool_call_id,
          content: message.content,
          status: message.status,
          additional_kwargs: message.additional_kwargs,
        })),
        snapshot: { type: "MESSAGES_SNAPSHOT", messages: restored },
      }),
    )
  } finally {
    clock.mockRestore()
  }
}

test("actual live events and checkpoint JSON round trips reproduce the shared golden fixture", async () => {
  const actual = await goldenFixture()
  const path = new URL("./fixtures/tool-step-events.json", import.meta.url)
  if (process.env.B4_UPDATE_TOOL_STEP_FIXTURE === "1")
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`)

  const expected = JSON.parse(readFileSync(path, "utf8"))

  expect(actual).toEqual(expected)
  expect(actual.persisted).toHaveLength(2)
})

test("real agent abort does not checkpoint a fabricated tool result", async () => {
  const controller = new AbortController()
  const reason = new Error("original cancellation")
  const checkpointer = new MemorySaver()
  const aborting = tool(
    async () => {
      controller.abort(reason)
      throw reason
    },
    { name: "aborting", description: "abort", schema },
  )
  const agent = createAgent({
    model: new ScriptedModel([{ name: "aborting", id: "aborted", args: {} }]),
    tools: [aborting],
    middleware: [toolStepMiddleware()],
    checkpointer,
  })
  const config = { configurable: { thread_id: "abort-test" }, signal: controller.signal }

  await expect(
    agent.invoke({ messages: [{ role: "user", content: "go" }] }, config),
  ).rejects.toThrow()
  const state = (await agent.getState({ configurable: config.configurable })) as unknown as {
    values: { messages: BaseMessage[] }
  }

  expect(state.values.messages.filter(isToolMessage)).toEqual([])
})
