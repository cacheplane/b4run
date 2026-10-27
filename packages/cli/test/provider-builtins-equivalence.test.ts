import { EventType } from "@ag-ui/core"
import { fromRunAgentInput, toAguiEvents } from "@b4run/ag-ui"
import { eventsFromState, reduceTurns, type TurnsView, turnsFromState } from "@b4run/ag-ui/view"
import { seedModelImporter, streamAgent } from "@b4run/langchain"
import { agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage, isAIMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { expect, test } from "vitest"

/** Compare display and contract data while keeping transport ids and clocks out. */
function contractView(view: TurnsView) {
  return view.turns.map((turn) => ({
    text: turn.text,
    status: turn.status,
    failed: turn.failed,
    answers: Object.values(turn.answers ?? {}),
    steps: turn.steps.flatMap((step) =>
      step.kind === "tool"
        ? [
            {
              id: step.id,
              name: step.name,
              args: step.args,
              result: step.result,
              label: step.label,
              status: step.status,
              toolKind: step.toolKind,
              provider: step.provider,
              builtin: step.builtin,
              queries: step.queries,
              sources: step.sources,
              error: step.error,
            },
          ]
        : [],
    ),
  }))
}

test("provider activity agrees live and after a real graph checkpoint without changing native replay", async () => {
  const seen: BaseMessage[][] = []
  const nativeOutputs = [
    {
      id: "native-search",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "weather",
        sources: [{ type: "url", url: "https://weather.test/report", title: "Weather" }],
      },
    },
  ]
  const nativeContent = [
    {
      type: "text" as const,
      text: "Weather report",
      annotations: [
        {
          type: "url_citation",
          url: "https://weather.test/report",
          title: "Weather",
          start_index: 0,
          end_index: 7,
        },
      ],
    },
  ]
  class ProviderModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "provider-builtins-equivalence"
    }
    bindTools() {
      return this
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      seen.push([...messages])
      const message =
        seen.length === 1
          ? new AIMessage({
              id: "native-answer",
              content: nativeContent,
              additional_kwargs: { tool_outputs: nativeOutputs },
              response_metadata: { model_provider: "openai", output_version: "v0" },
            })
          : new AIMessage({ id: "next-answer", content: "Next answer" })
      return {
        generations: [{ text: seen.length === 1 ? "Weather report" : "Next answer", message }],
      }
    }
    async *_streamResponseChunks(
      messages: BaseMessage[],
      _options: Record<string, unknown>,
      runManager?: CallbackManagerForLLMRun,
    ) {
      const result = await this._generate(messages)
      const generation = result.generations[0]
      if (!generation) throw new Error("Missing scripted generation")
      const message = generation.message as AIMessage
      const chunk = new ChatGenerationChunk({
        text: generation.text,
        message: new AIMessageChunk({
          content: message.content,
          ...(message.id ? { id: message.id } : {}),
          additional_kwargs: message.additional_kwargs,
          response_metadata: message.response_metadata,
        }),
      })
      yield chunk
      await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, {
        chunk,
      })
    }
  }
  const checkpointer = new MemorySaver()
  const entry = agent({
    model: "gpt-5-mini",
    systemPrompt: "Report the weather.",
    builtInTools: { openai: { webSearch: true } },
  })
  const threadId = "provider-equivalence"
  const runOptions = {
    entry,
    checkpointer,
    threadId,
    signal: new AbortController().signal,
    routeParamNames: [],
    tools: [],
  }
  seedModelImporter(async () => ({ ChatOpenAI: ProviderModel }))

  try {
    const liveEvents = []
    for await (const event of toAguiEvents(
      streamAgent({ ...runOptions, input: { messages: [{ role: "user", content: "Weather?" }] } }),
      { threadId, runId: "live-run" },
    ))
      liveEvents.push(event)
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } })
    const messages = tuple?.checkpoint.channel_values.messages as BaseMessage[]
    const saved = messages.find((message) => isAIMessage(message)) as AIMessage
    const state = {
      threadId,
      status: "idle" as const,
      root: [
        {
          id: tuple?.checkpoint.id ?? "checkpoint",
          ts: tuple?.checkpoint.ts ?? new Date().toISOString(),
          metadata: {},
          values: { messages: JSON.parse(JSON.stringify(messages)) },
        },
      ],
      children: {},
      pendingInterrupts: [],
    }
    const restored = turnsFromState(state)
    const restoredEvents = eventsFromState(state)
    const live = liveEvents.reduce((view, event) => reduceTurns(view, event), {
      turns: [],
    } as TurnsView)
    const providerResult = liveEvents.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    const inbound = fromRunAgentInput({
      threadId,
      runId: "restored-input",
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      messages: [
        { id: "assistant", role: "assistant", content: "Weather report" },
        {
          id: "provider-result",
          role: "tool",
          toolCallId: "native-search",
          content: "Completed",
          ...(providerResult?.metadata ? { metadata: providerResult.metadata } : {}),
        },
      ],
    })
    for await (const _chunk of streamAgent({
      ...runOptions,
      input: { messages: [{ role: "user", content: "Continue" }] },
    })) {
      /* Drain the second real model turn. */
    }
    const replayed = seen[1]?.find((message) => message.id === "native-answer") as AIMessage

    expect(saved.additional_kwargs.b4_steps).toMatchObject({
      "native-search": { kind: "provider", provider: "openai", status: "completed" },
    })
    expect(saved.additional_kwargs.b4_answer).toMatchObject({
      v: 1,
      citations: [{ sourceId: "native-search:source:0" }],
    })
    expect(restored.warnings).toEqual([])
    expect(contractView(restored.turns)).toEqual(contractView(live))
    expect(live.turns[0]?.steps).toHaveLength(1)
    expect(liveEvents.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(true)
    expect(replayed.content).toEqual(nativeContent)
    expect(replayed.additional_kwargs.tool_outputs).toEqual(nativeOutputs)
    expect(replayed.tool_calls).toEqual([])
    expect(messages.some((message) => message.getType() === "tool")).toBe(false)
    expect(inbound.messages).toEqual([
      { id: "assistant", role: "assistant", content: "Weather report" },
    ])
    expect(
      restoredEvents.events.filter((event) => event.type === EventType.TOOL_CALL_START),
    ).toHaveLength(1)
  } finally {
    seedModelImporter(async (specifier) => import(specifier))
  }
})
