import { defaultSummarize, streamAgent } from "@b4run/langchain"
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary } from "../src/lib/runtime/inputs.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each(["model", "tool", "stream", "summary"] as const)(
  "keeps exact execution ownership until the actual abort-ignoring %s primitive unwinds",
  async (primitive) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred(),
      aborted = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      cancellation: Promise<void> | undefined
    let calls = 0,
      effects = 0,
      unwound = false,
      finalized = false,
      failure: unknown
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "controlled-abort-ignoring"
      }
      bindTools() {
        return this
      }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        if (primitive === "model" || primitive === "summary") {
          entered.resolve()
          await release.promise
        }
        const message =
          primitive === "tool"
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "issued-effect", name: "effect", args: {} }],
              })
            : new AIMessage("finished")
        return { generations: [{ text: "", message }] }
      }
    }
    class StreamingControlledModel extends ControlledModel {
      async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
        calls++
        try {
          yield new ChatGenerationChunk({ text: "first", message: new AIMessageChunk("first") })
          entered.resolve()
          await release.promise
          yield new ChatGenerationChunk({ text: "last", message: new AIMessageChunk("last") })
        } finally {
          finalized = true
        }
      }
    }
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: primitive === "stream" ? StreamingControlledModel : ControlledModel,
    }))
    try {
      const accepted = await f.admit(
        body({
          on_completion: "keep",
          ...(primitive === "summary"
            ? {
                input: {
                  messages: [
                    { role: "user", content: "old conversation", id: "old-user" },
                    { role: "assistant", content: "old answer", id: "old-answer" },
                    { role: "user", content: "current turn", id: "current-user" },
                  ],
                },
              }
            : {}),
        }),
      )
      host = createExecutionHost({
        ...f.authority,
        async invoke({ store, run, signal }) {
          signal.addEventListener("abort", aborted.resolve, { once: true })
          const boundary = createActiveInputBoundary({
            store,
            runId: run.run.run_id,
            namespace: [],
            namespaceGeneration: run.run.run_id,
          })
          const checkpointer = createRuntimeCheckpointSaver({
            store,
            runId: run.run.run_id,
            namespace: [],
            commitInputs: boundary.commitInputs,
          })
          try {
            for await (const _chunk of streamAgent({
              checkpointer,
              activeInput: boundary.activeInput,
              entry: agent({ model: "gpt-5-mini", systemPrompt: "Controlled ownership." }),
              input: run.run.input,
              threadId: accepted.threadId,
              routeParamNames: [],
              signal,
              ...(primitive === "summary"
                ? {
                    summarization: {
                      maxTokens: 1,
                      keepRecentTurns: 1,
                      model: "gpt-5-mini",
                      tokenCounter: () => 100,
                      summarize: defaultSummarize,
                    },
                  }
                : {}),
              tools: [
                {
                  name: "effect",
                  description: "An issued effect.",
                  run: async () => {
                    entered.resolve()
                    await release.promise
                    effects++
                    return "completed"
                  },
                },
              ],
            })) {
              /* consume the actual stream */
            }
          } catch (error) {
            failure = error
            throw error
          } finally {
            unwound = true
          }
          return {}
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw failure ?? new Error("Primitive never entered")
        }),
      ])
      cancellation = host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
      await aborted.promise
      const observation = await Promise.race([
        host.idle().then(() => "settled"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ])
      expect(observation).toBe("held")
      expect(unwound).toBe(false)
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).not.toBeNull()
      await expect(
        f.admit(
          body({
            thread_id: accepted.threadId,
            on_completion: "keep",
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
          }),
        ),
      ).rejects.toMatchObject({ code: "thread_busy" })
      release.resolve()
      await cancellation
      await host.idle()
      expect(unwound).toBe(true)
      if (primitive === "stream") expect(finalized).toBe(true)
      expect(calls).toBe(1)
      expect(effects).toBe(primitive === "tool" ? 1 : 0)
    } finally {
      release.resolve()
      await cancellation
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
