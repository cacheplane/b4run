/**
 * `agent({ retry })` on a real `createAgent` graph, through `streamAgent`:
 * retry belongs to each model call, never to the run.
 *
 * The model is a streaming fake that plays a script, one step per model call,
 * and throws errors LangChain itself classified (see `helpers/langchain-errors`).
 * The capacity-429 backoff runs on vitest's fake `setTimeout`, advanced by hand.
 */

import { agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  __resetMaterializedAgentsForTests,
  type AgentStreamChunk,
  materializeAgentGraph,
  streamAgent,
} from "../src/agent-adapter.ts"
import type { ResolvedSummarizationConfig, SummarizeFn } from "../src/summarization/index.ts"
import {
  headerlessRateLimit,
  longRetryAfterRateLimit,
  quotaExhausted,
  serviceUnavailable,
} from "./helpers/langchain-errors.ts"

type Step =
  | { readonly kind: "fail"; readonly error: Error }
  | { readonly kind: "text"; readonly tokens: readonly string[] }
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly args: object }
  | { readonly kind: "text-then-fail"; readonly tokens: readonly string[]; readonly error: Error }

let script: Step[] = []
let modelCalls = 0
/** Fake-clock time of each model call, in order. */
let callTimes: number[] = []
let constructedWith: Record<string, unknown>[] = []

class ScriptedStreamingModel extends BaseChatModel {
  constructor(options: Record<string, unknown>) {
    super({})
    constructedWith.push(options)
  }
  _llmType(): string {
    return "scripted-streaming-fake"
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
  async _generate(): Promise<ChatResult> {
    throw new Error("the agent graph streams every model call")
  }
  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const step = script[modelCalls]
    modelCalls += 1
    callTimes.push(Date.now())
    if (!step) throw new Error("ScriptedStreamingModel ran out of steps")
    if (step.kind === "fail") throw step.error
    if (step.kind === "call") {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            { id: step.id, name: step.name, args: JSON.stringify(step.args), index: 0 },
          ],
        }),
      })
      return
    }
    for (const token of step.tokens) {
      const chunk = new ChatGenerationChunk({
        text: token,
        message: new AIMessageChunk({ content: token }),
      })
      yield chunk
      await runManager?.handleLLMNewToken(token, undefined, undefined, undefined, undefined, {
        chunk,
      })
    }
    if (step.kind === "text-then-fail") throw step.error
  }
}

let toolRuns = 0
const lookup = {
  name: "lookup",
  description: "Look up an order.",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (input: unknown) => {
    toolRuns += 1
    return { status: "shipped", id: (input as { id: string }).id }
  },
}

interface TurnResult {
  readonly chunks: AgentStreamChunk[]
  readonly error: unknown
}

function startTurn(options: {
  readonly retry?: { maxAttempts?: number; baseDelay?: number }
  readonly signal?: AbortSignal
  readonly summarization?: ResolvedSummarizationConfig
  readonly userMessages?: readonly string[]
}): Promise<TurnResult> {
  const chunks: AgentStreamChunk[] = []
  return (async () => {
    try {
      for await (const chunk of streamAgent({
        checkpointer: new MemorySaver(),
        entry: agent({
          model: "gpt-5-mini",
          systemPrompt: "Answer order questions.",
          ...(options.retry ? { retry: options.retry } : {}),
        }),
        input: {
          messages: (options.userMessages ?? ["where is order 7?"]).map((content) => ({
            role: "user",
            content,
          })),
        },
        routeParamNames: [],
        signal: options.signal ?? new AbortController().signal,
        threadId: `retry-${Math.random()}`,
        tools: [lookup],
        ...(options.summarization ? { summarization: options.summarization } : {}),
      })) {
        chunks.push(chunk)
      }
      return { chunks, error: undefined }
    } catch (error) {
      return { chunks, error }
    }
  })()
}

function tokens(chunks: readonly AgentStreamChunk[]): string[] {
  return chunks.filter((c) => c.type === "token").map((c) => String(c.data))
}

/** Advance fake time 1ms at a time until `modelCalls` reaches `calls`. */
async function advanceUntilCalls(calls: number, limitMs: number): Promise<void> {
  for (let elapsed = 0; modelCalls < calls && elapsed < limitMs; elapsed += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

/** Milliseconds between consecutive model calls. */
function gapsBetweenCalls(): number[] {
  return callTimes.slice(1).map((time, i) => time - (callTimes[i] as number))
}

/** `createAgent` wraps an error thrown out of a middleware; the cause is the model's. */
function modelError(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error
}

/** Let a turn finish, running any timers it (or its error path) arms. */
async function settle<T>(turn: Promise<T>): Promise<T> {
  let settled = false
  let result: T | undefined
  void turn.then((r) => {
    settled = true
    result = r
  })
  for (let i = 0; !settled && i < 1000; i += 1) {
    await vi.advanceTimersByTimeAsync(100)
  }
  if (!settled) throw new Error("the turn never settled")
  return result as T
}

beforeEach(() => {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedStreamingModel }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock("@langchain/openai")
  script = []
  modelCalls = 0
  callTimes = []
  toolRuns = 0
  constructedWith = []
  __resetMaterializedAgentsForTests()
})

describe("maxAttempts reaches the chat model as maxRetries", () => {
  test.each([
    [undefined, 2],
    [{ maxAttempts: 1 }, 0],
    [{ maxAttempts: 5, baseDelay: 10 }, 4],
  ])("retry %j → maxRetries %i", async (retry, maxRetries) => {
    await materializeAgentGraph({
      descriptor: agent({
        model: "gpt-5-mini",
        systemPrompt: "x",
        ...(retry ? { retry } : {}),
      }),
    })
    expect(constructedWith.at(-1)?.maxRetries).toBe(maxRetries)
  })

  test("an invalid maxAttempts fails the route before any model call", async () => {
    await expect(
      materializeAgentGraph({
        descriptor: agent({ model: "gpt-5-mini", systemPrompt: "x", retry: { maxAttempts: 0 } }),
      }),
    ).rejects.toThrow(/retry\.maxAttempts/)
    expect(constructedWith).toEqual([])
  })
})

describe("the route's retry reaches the summarizer", () => {
  test.each([
    [undefined, 2],
    [{ maxAttempts: 1 }, 0],
    [{ maxAttempts: 5 }, 4],
  ])("retry %j → summarize gets maxRetries %i", async (retry, maxRetries) => {
    const summarize = vi.fn<SummarizeFn>(async () => "earlier: asked about order 6")
    script = [{ kind: "text", tokens: ["Order 7 has shipped."] }]
    const { error } = await settle(
      startTurn({
        ...(retry ? { retry } : {}),
        userMessages: ["where is order 6?", "where is order 7?"],
        summarization: {
          maxTokens: 1,
          keepRecentTurns: 1,
          model: "gpt-5-mini",
          tokenCounter: (text) => text.length,
          summarize,
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0]?.[0].maxRetries).toBe(maxRetries)
  })
})

describe("the capacity-429 layer", () => {
  test("retries a capacity 429 on the second model call of a tool loop with baseDelay backoff", async () => {
    script = [
      { kind: "call", id: "call_1", name: "lookup", args: { id: "7" } },
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "text", tokens: ["Order 7 ", "has shipped."] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 200 } }))

    expect(error).toBeUndefined()
    expect(modelCalls).toBe(4)
    // The tool runs between calls 1 and 2 on no timer; then the first retry
    // waits baseDelay (jitter pinned to 0), the second twice that.
    expect(gapsBetweenCalls()).toEqual([0, 200, 400])
    expect(toolRuns).toBe(1)
    expect(tokens(chunks)).toEqual(["Order 7 ", "has shipped."])
    expect(chunks.filter((c) => c.type === "tool_call")).toHaveLength(1)
    expect(chunks.filter((c) => c.type === "tool_result")).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe("done")
  })

  test("gives up after maxAttempts capacity 429s and surfaces the error", async () => {
    const capacity = await headerlessRateLimit()
    script = [
      { kind: "fail", error: capacity },
      { kind: "fail", error: capacity },
    ]
    const { error } = await settle(startTurn({ retry: { maxAttempts: 2, baseDelay: 50 } }))
    expect(modelError(error)).toBe(capacity)
    expect(modelCalls).toBe(2)
    expect(gapsBetweenCalls()).toEqual([50])
  })

  test("a quota 429 is not retried", async () => {
    const quota = await quotaExhausted()
    script = [{ kind: "fail", error: quota }]
    const { error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(quota)
    expect(modelCalls).toBe(1)
  })

  test("a Retry-After longer than 10 seconds is surfaced at once, not retried", async () => {
    const longWait = await longRetryAfterRateLimit(120)
    script = [
      { kind: "fail", error: longWait },
      { kind: "text", tokens: ["never"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    // Exactly one request, and the error keeps the server's wait.
    expect(modelCalls).toBe(1)
    expect(modelError(error)).toBe(longWait)
    expect((modelError(error) as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
    expect(tokens(chunks)).toEqual([])
  })

  test("a retryAfterMs within 10 seconds is waited out, then the call is sent again", async () => {
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    script = [
      { kind: "fail", error: shortWait },
      { kind: "text", tokens: ["done"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 2, baseDelay: 50 } }))
    expect(error).toBeUndefined()
    // The server's 3000ms, not the 50ms baseDelay.
    expect(gapsBetweenCalls()).toEqual([3000])
    expect(tokens(chunks)).toEqual(["done"])
  })

  test("an abort during the backoff wait stops the retry", async () => {
    const controller = new AbortController()
    script = [
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "text", tokens: ["never"] },
    ]
    const turn = startTurn({
      retry: { maxAttempts: 3, baseDelay: 5000 },
      signal: controller.signal,
    })
    await advanceUntilCalls(1, 1000)
    await vi.advanceTimersByTimeAsync(100)
    const reason = new Error("client went away")
    controller.abort(reason)
    const { chunks, error } = await settle(turn)
    expect(modelError(error)).toBe(reason)
    // The run is over; nothing is left waiting to send the call again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(modelCalls).toBe(1)
    expect(tokens(chunks)).toEqual([])
  })
})

describe("no run-level retry", () => {
  test("a failure after tokens streamed is not retried, and no token is emitted twice", async () => {
    const dropped = serviceUnavailable()
    script = [
      { kind: "text-then-fail", tokens: ["Order ", "7 "], error: dropped },
      { kind: "text", tokens: ["Order ", "7 ", "has shipped."] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(dropped)
    expect(modelCalls).toBe(1)
    expect(tokens(chunks)).toEqual(["Order ", "7 "])
  })

  test("a failure before anything streamed does not restart the run", async () => {
    // A transient-looking error the old run-level retry matched on its text.
    const early = new Error("503 Service Unavailable")
    script = [
      { kind: "fail", error: early },
      { kind: "text", tokens: ["recovered"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(early)
    expect(modelCalls).toBe(1)
    expect(chunks).toEqual([])
  })

  test("a raw runnable's stream is opened once, before or after output", async () => {
    for (const yieldFirst of [false, true]) {
      let opened = 0
      const entry = {
        invoke: async () => ({}),
        async *streamEvents() {
          opened += 1
          if (yieldFirst) {
            yield {
              event: "on_chat_model_stream",
              run_id: "m1",
              name: "model",
              data: { chunk: { content: "partial" } },
            }
          }
          throw new Error("503 Service Unavailable")
        },
      }
      const chunks: AgentStreamChunk[] = []
      const error = await settle(
        (async () => {
          try {
            for await (const chunk of streamAgent({
              entry,
              checkpointer: new MemorySaver(),
              input: {},
              tools: [],
              routeParamNames: [],
              signal: new AbortController().signal,
            })) {
              chunks.push(chunk)
            }
            return undefined
          } catch (caught) {
            return caught
          }
        })(),
      )
      expect((error as Error).message).toBe("503 Service Unavailable")
      expect(opened).toBe(1)
      expect(tokens(chunks)).toEqual(yieldFirst ? ["partial"] : [])
    }
  })
})
