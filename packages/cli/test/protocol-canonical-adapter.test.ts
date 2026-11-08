import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import * as runtime from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary } from "../src/lib/runtime/inputs.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))
it.each(["execute", "stream"] as const)(
  "binds canonical %s to its exact owned native scope",
  async (mode) => {
    const f = await fixture()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      callbacks = 0,
      failure: unknown
    let retained: Parameters<typeof runtime.bindProtocolAgentExecution>[0] | undefined
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "canonical-native-scope"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        return { generations: [{ text: "done", message: new AIMessage("done") }] }
      }
      async *_streamResponseChunks(
        _messages: BaseMessage[],
        _options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ) {
        calls++
        const chunk = new ChatGenerationChunk({
          text: "done",
          message: new AIMessageChunk({ content: "done" }),
        })
        yield chunk
        await runManager?.handleLLMNewToken("done", undefined, undefined, undefined, undefined, {
          chunk,
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke({ store, run, signal }) {
          try {
            const boundary = createActiveInputBoundary({
              store,
              runId: run.run.run_id,
              namespace: [],
              namespaceGeneration: run.run.run_id,
            })
            const saver = createRuntimeCheckpointSaver({
              store,
              runId: run.run.run_id,
              namespace: [],
              commitInputs: boundary.commitInputs,
            })
            const graph = await materializeAgentGraph({
              descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Owned scope." }),
              checkpointer: saver,
              activeInput: boundary.activeInput,
            })
            const options = {
              store,
              runId: run.run.run_id,
              checkpointer: saver,
              entry: graph,
              config: {
                configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
                callbacks: [
                  {
                    name: "preserved-native-callback",
                    handleLLMEnd() {
                      callbacks++
                    },
                  },
                ],
              },
            }
            const before = await store.snapshot()
            await expect(
              runtime.bindProtocolAgentExecution({
                ...options,
                config: { configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: "" } },
              }),
            ).rejects.toMatchObject({ code: "not_found" })
            await expect(
              runtime.bindProtocolAgentExecution({
                ...options,
                config: {
                  configurable: { thread_id: accepted.threadId, checkpoint_ns: "foreign" },
                },
              }),
            ).rejects.toMatchObject({ code: "not_found" })
            await expect(
              runtime.bindProtocolAgentExecution({
                ...options,
                config: {
                  configurable: {
                    thread_id: accepted.threadId,
                    checkpoint_ns: "",
                    checkpoint_id: crypto.randomUUID(),
                  },
                },
              }),
            ).rejects.toMatchObject({ code: "stale_generation" })
            await expect(
              runtime.bindProtocolAgentExecution({
                ...options,
                config: {
                  configurable: {
                    thread_id: accepted.threadId,
                    checkpoint_ns: "",
                    checkpoint_map: { "": crypto.randomUUID() },
                  },
                },
              }),
            ).rejects.toMatchObject({ code: "stale_generation" })
            const otherSaver = createRuntimeCheckpointSaver({
              store,
              runId: run.run.run_id,
              namespace: [],
              commitInputs: boundary.commitInputs,
            })
            await expect(
              runtime.bindProtocolAgentExecution({ ...options, checkpointer: otherSaver }),
            ).rejects.toMatchObject({ code: "not_supported" })
            const legacy = await materializeAgentGraph({
              descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Unowned materialization." }),
              checkpointer: saver,
            })
            await expect(
              runtime.bindProtocolAgentExecution({ ...options, entry: legacy }),
            ).rejects.toMatchObject({ code: "not_supported" })
            expect(await store.snapshot()).toEqual(before)
            expect(calls).toBe(0)
            await runtime.bindProtocolAgentExecution(options)
            retained = options
            await expect(runtime.bindProtocolAgentExecution(options)).rejects.toMatchObject({
              code: "not_supported",
            })
            // The binding copied containers; later caller edits cannot retarget it
            // or add a callback. Opaque handler identities remain live and mutable.
            expect(Object.isFrozen(options.config.callbacks[0])).toBe(false)
            options.config.configurable.thread_id = crypto.randomUUID()
            options.config.callbacks.push({
              name: "late-callback",
              handleLLMEnd() {
                throw new Error("Late caller callback executed")
              },
            })
            if (mode === "execute")
              await agentBackendAdapter.execute(graph, run.run.input, { signal })
            else {
              const chunks: { type?: string; data?: unknown }[] = []
              for await (const chunk of agentBackendAdapter.stream(graph, run.run.input, {
                signal,
              }))
                chunks.push(chunk as { type?: string; data?: unknown })
              expect(
                chunks
                  .filter((chunk) => chunk.type === "token")
                  .map((chunk) => chunk.data)
                  .join(""),
              ).toBe("done")
              expect(chunks.filter((chunk) => chunk.type === "done")).toHaveLength(1)
            }
            return {}
          } catch (error) {
            failure = error
            throw error
          }
        },
      })
      await host.tick()
      await host.idle()
      if (failure) throw failure
      expect(calls).toBe(1)
      expect(callbacks).toBe(1)
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === accepted.runId)
          ?.run.status,
      ).toBe("success")
      await expect(runtime.bindProtocolAgentExecution(retained!)).rejects.toMatchObject({
        code: "stale_fence",
      })
    } finally {
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
