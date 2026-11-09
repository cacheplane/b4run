import { materializeAgentGraph, streamAgent } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { bindProtocolAgentExecution } from "../src/lib/runtime/execute-route-core.ts"
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

it.each(
  (["consumer-close", "node-error"] as const).flatMap((mode) =>
    (["established", "canonical"] as const).map((path) => ({ mode, path })),
  ),
)(
  "settles the same native producer after $mode/$path before releasing the owner",
  async ({ mode, path }) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred(),
      close = deferred(),
      consumer = deferred(),
      writeFailed = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      effects = 0,
      armed = false,
      fired = false,
      failure: unknown
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "controlled-unwind-edge"
      }
      bindTools() {
        return this
      }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        if (mode === "consumer-close" && calls > 1)
          return { generations: [{ text: "done", message: new AIMessage("done") }] }
        return {
          generations: [
            {
              text: "",
              message: new AIMessage({
                content: "",
                tool_calls: [
                  { id: "slow-issued", name: "slow", args: {} },
                  ...(mode === "node-error" ? [{ id: "fast-issued", name: "fast", args: {} }] : []),
                ],
              }),
            },
          ],
        }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke({ store, run, signal }) {
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
            failpoint(point) {
              if (point === "afterWrites" && armed && !fired) {
                fired = true
                writeFailed.resolve()
                throw new Error("task-writes-fault")
              }
            },
          })
          const tools = [
            {
              name: "slow",
              description: "Slow issued effect.",
              run: async () => {
                entered.resolve()
                await release.promise
                effects++
                return "slow complete"
              },
            },
            {
              name: "fast",
              description: "Complete while sibling works.",
              run: async () => {
                await entered.promise
                armed = true
                return "fast complete"
              },
            },
          ]
          try {
            const graph =
              path === "canonical"
                ? await materializeAgentGraph({
                    descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Canonical edge." }),
                    checkpointer,
                    activeInput: boundary.activeInput,
                    tools,
                  })
                : undefined
            if (graph)
              await bindProtocolAgentExecution({
                store,
                runId: run.run.run_id,
                checkpointer,
                entry: graph,
                config: { configurable: { thread_id: accepted.threadId, checkpoint_ns: "" } },
              })
            if (mode === "consumer-close") {
              const chunks = graph
                ? agentBackendAdapter.stream(graph, run.run.input, { signal })
                : streamAgent({
                    checkpointer,
                    activeInput: boundary.activeInput,
                    entry: agent({ model: "gpt-5-mini", systemPrompt: "Close." }),
                    input: run.run.input,
                    routeParamNames: [],
                    signal,
                    threadId: accepted.threadId,
                    tools,
                  })
              for await (const value of chunks) {
                const chunk = value as { type: string }
                if (chunk.type === "tool_call") {
                  await entered.promise
                  consumer.resolve()
                  await close.promise
                  break
                }
              }
              throw new Error("consumer closed")
            }
            if (graph) await agentBackendAdapter.execute(graph, run.run.input, { signal })
            else {
              const established = (await materializeAgentGraph({
                descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Node error." }),
                checkpointer,
                activeInput: boundary.activeInput,
                tools,
              })) as { invoke(input: unknown, config: unknown): Promise<unknown> }
              await established.invoke(run.run.input, {
                configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
                signal,
                durability: "sync",
              })
            }
          } catch (error) {
            failure = error
            throw error
          }
          return {}
        },
      })
      await host.tick()
      const observed = mode === "consumer-close" ? consumer.promise : writeFailed.promise
      await Promise.race([
        observed,
        host.idle().then(() => {
          throw failure ?? new Error("Expected edge did not occur")
        }),
      ])
      close.resolve()
      expect(
        await Promise.race([
          host.idle().then(() => "settled"),
          new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
        ]),
      ).toBe("held")
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).not.toBeNull()
      expect(effects).toBe(0)
      release.resolve()
      await host.idle()
      // Closing an execution consumer does not manufacture a Stop request.
      // Without Stop, this same native invocation reaches its natural final model.
      expect(calls).toBe(mode === "consumer-close" ? 2 : 1)
      expect(effects).toBe(1)
      expect(String(failure)).toContain(
        mode === "consumer-close" ? "consumer closed" : "task-writes-fault",
      )
    } finally {
      close.resolve()
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
