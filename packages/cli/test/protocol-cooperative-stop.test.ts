import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent, isCooperativeStop } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import {
  bindProtocolAgentExecution,
  bindProtocolChildGraph,
} from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import {
  childInputExecution,
  createActiveInputBoundary,
  createInputService,
} from "../src/lib/runtime/inputs.ts"
import { parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
afterEach(() => vi.doUnmock("@langchain/openai"))

it.each(["execute", "stream"] as const)(
  "canonical %s observes Stop while an owned native child is prepared",
  async (mode) => {
    const f = await fixture(),
      prepared = deferred(),
      release = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      observedError: unknown,
      childError: unknown,
      hardSignal: AbortSignal | undefined,
      waiting: Promise<void> | undefined,
      waited = false
    class ChildPreparationModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "owned-child-preparation"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        if (++calls !== 1) throw new Error("Stop dispatched a prepared child or next parent model")
        return {
          generations: [
            {
              text: "",
              message: new AIMessage({
                content: "",
                tool_calls: [{ id: "prepare-child", name: "delegate", args: {} }],
              }),
            },
          ],
        }
      }
      async *_streamResponseChunks() {
        const result = await this._generate(),
          message = result.generations[0]!.message as AIMessage
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
          }),
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: ChildPreparationModel,
    }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
          const boundary = createActiveInputBoundary({
            store, runId: run.run.run_id, namespace: [], namespaceGeneration: run.run.run_id,
          })
          const saver = createRuntimeCheckpointSaver({
            store,
            runId: run.run.run_id,
            namespace: [],
            commitInputs: boundary.commitInputs,
          })
          const graph = await materializeAgentGraph({
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Prepare an owned child.",
            }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "delegate",
                description: "Prepare an owned native child.",
                async run() {
                  const config = getConfig()
                  if (!config) throw new Error("Missing actual native tool config")
                  const child = await childInputExecution(saver, "child#agent", config)
                  if (!child) throw new Error("Missing owned native child")
                  const childGraph = (await materializeAgentGraph({
                    descriptor: agent({
                      model: "gpt-5-mini",
                      systemPrompt: "Child must not dispatch.",
                    }),
                    checkpointer: child.checkpointer,
                    activeInput: child.activeInput,
                  })) as {
                    invoke(input: unknown, config: RunnableConfig): Promise<unknown>
                  }
                  const owned = bindProtocolChildGraph(childGraph, child)
                  hardSignal = context.signal
                  prepared.resolve()
                  await release.promise
                  try {
                    return await owned.invoke({ messages: [{ role: "user", content: "child" }] }, config)
                  } catch (error) {
                    childError = error
                    throw error
                  }
                },
              },
            ],
          })
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            },
          })
          try {
            if (mode === "execute") await agentBackendAdapter.execute(graph, run.run.input, context)
            else
              for await (const _chunk of agentBackendAdapter.stream(
                graph,
                run.run.input,
                context,
              )) {
              }
            return {}
          } catch (error) {
            observedError = error
            throw error
          }
        },
      })
      await host.tick()
      await Promise.race([
        prepared.promise,
        host.idle().then(() => {
          throw observedError ?? new Error("Native child preparation did not enter")
        }),
      ])
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {
        wait: false,
      })
      waiting = host
        .cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
        .then(() => {
          waited = true
        })
      expect(hardSignal?.aborted).toBe(false)
      expect(waited).toBe(false)
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).not.toBeNull()
      release.resolve()
      await waiting
      await host.idle()
      expect(calls).toBe(1)
      expect(childError).toMatchObject({ name: "GraphDrained" })
      expect(isCooperativeStop(observedError)).toBe(true)
      const row = (await f.snapshot(accepted.threadId)).runs[0]
      expect(row?.run.status).toBe("interrupted")
      expect(row?.metadata.reason).toBe("user_stop")
    } finally {
      release.resolve()
      await waiting
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it.each([
  ["execute", "settle"],
  ["stream", "settle"],
  ["execute", "reject"],
  ["stream", "reject"],
  ["stream-close", "settle"],
  ["stream-close", "reject"],
] as const)(
  "canonical %s Stop holds ownership through a real saver %s",
  async (mode, write) => {
    const f = await fixture(),
      entered = deferred(),
      toolRelease = deferred(),
      writing = deferred(),
      writeRelease = deferred(),
      closeRequest = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined
    let waiting: Promise<void> | undefined,
      waited = false,
      calls = 0,
      effects = 0
    let toolSignal: AbortSignal | undefined,
      observedError: unknown,
      unwound = false
    const checkpointFailure = new Error("controlled actual saver failure")
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "durable-cooperative-stop"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        const message =
          calls === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "controlled-effect", name: "effect", args: {} }],
              })
            : new AIMessage("done")
        return { generations: [{ text: "", message }] }
      }
      async *_streamResponseChunks() {
        const result = await this._generate()
        const generation = result.generations[0]
        if (!generation) throw new Error("Controlled model omitted its generation")
        const message = generation.message as AIMessage
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
          }),
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
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
          const originalPut = saver.put.bind(saver)
          vi.spyOn(saver, "put").mockImplementation(async (...args) => {
            const saved = await originalPut(...args)
            if (effects) {
              writing.resolve()
              await writeRelease.promise
              if (write === "reject") throw checkpointFailure
            }
            return saved
          })
          const graph = await materializeAgentGraph({
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Controlled native Stop.",
            }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "effect",
                description: "Controlled effect.",
                async run(_input, ctx) {
                  toolSignal = ctx.signal
                  entered.resolve()
                  await toolRelease.promise
                  effects++
                  return "finished"
                },
              },
            ],
          })
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            },
          })
          try {
            if (mode === "execute") await agentBackendAdapter.execute(graph, run.run.input, context)
            else
              for await (const chunk of agentBackendAdapter.stream(graph, run.run.input, context)) {
                if (mode === "stream-close" && (chunk as { type?: string }).type === "tool_call") {
                  await entered.promise
                  await closeRequest.promise
                  break
                }
              }
            return {}
          } catch (error) {
            observedError = error
            throw error
          } finally {
            unwound = true
          }
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw observedError ?? new Error("Tool did not enter")
        }),
      ])
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {
        wait: false,
      })
      waiting = host
        .cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
        .then(() => {
          waited = true
        })
      // Durable acceptance alone cannot stop the active tool or release its owner.
      expect(toolSignal?.aborted).toBe(false)
      expect(unwound).toBe(false)
      expect(waited).toBe(false)
      closeRequest.resolve()
      toolRelease.resolve()
      await Promise.race([
        writing.promise,
        host.idle().then(() => {
          throw observedError ?? new Error("Saver write did not enter")
        }),
      ])
      expect(toolSignal?.aborted).toBe(false)
      expect(unwound).toBe(false)
      expect(waited).toBe(false)
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
      writeRelease.resolve()
      await waiting
      await host.idle()
      expect(effects).toBe(1)
      expect(calls).toBe(1)
      expect(unwound).toBe(true)
      const row = (await f.snapshot(accepted.threadId)).runs.find(
        (r) => r.run.run_id === accepted.runId,
      )
      if (!row) throw new Error("Missing settled canonical Run")
      expect(row.unwoundAt).toBeDefined()
      if (write === "reject") {
        expect(observedError).toBe(checkpointFailure)
        expect(row.run.status).toBe("error")
        expect(row.metadata.reason).toBe("execution_error")
      } else {
        expect(isCooperativeStop(observedError)).toBe(true)
        expect(row.run.status).toBe("interrupted")
        expect(row.metadata.reason).toBe("user_stop")
      }
    } finally {
      closeRequest.resolve()
      toolRelease.resolve()
      writeRelease.resolve()
      await waiting
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it.each(["success", "error", "permission"] as const)(
  "accepted Stop preserves an independent %s outcome",
  async (outcome) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke({ store, run }) {
          entered.resolve()
          await release.promise
          if (outcome === "error") throw new Error("independent failure")
          if (outcome === "permission")
            await store.transaction((tx) =>
              parkPermissions(
                tx,
                run.run.run_id,
                [
                  {
                    interruptId: "independent-permission",
                    namespace: [],
                    request: {
                      kind: "tool",
                      detail: {
                        toolName: "effect",
                        suggestedPattern: "effect",
                      },
                    },
                    protectedProposal: {},
                  },
                ],
                "required",
              ),
            )
          // User data cannot forge a Stop outcome.
          return { values: { cancelled: true } }
        },
      })
      await host.tick()
      await entered.promise
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {
        wait: false,
      })
      release.resolve()
      await host.idle()
      const snapshot = await f.snapshot(accepted.threadId)
      expect(snapshot.runs[0]?.run.status).toBe(outcome === "permission" ? "interrupted" : outcome)
      expect(snapshot.runs[0]?.metadata.reason).toBe(
        outcome === "success"
          ? "completed"
          : outcome === "error"
            ? "execution_error"
            : "permission",
      )
      if (outcome === "permission") {
        expect(snapshot.runs[0]?.metadata.continuation).toBe("waiting")
        expect(snapshot.thread?.pausedGeneration).not.toBeNull()
        expect(snapshot.pending[0]?.disposition).toBe("pending")
      }
    } finally {
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it.each([
  ["execute", "success"],
  ["stream", "success"],
  ["execute", "error"],
  ["stream", "error"],
] as const)(
  "canonical %s preserves final native model %s after accepted Stop",
  async (mode, outcome) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      observedError: unknown
    class FinalModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "final-native-outcome"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        entered.resolve()
        await release.promise
        if (outcome === "error") throw new Error("independent-native-model-failure")
        return {
          generations: [{ text: "done", message: new AIMessage("done") }],
        }
      }
      async *_streamResponseChunks() {
        await this._generate()
        yield new ChatGenerationChunk({
          text: "done",
          message: new AIMessageChunk("done"),
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FinalModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
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
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Final native outcome.",
            }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
          })
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            },
          })
          try {
            if (mode === "execute") await agentBackendAdapter.execute(graph, run.run.input, context)
            else
              for await (const _chunk of agentBackendAdapter.stream(
                graph,
                run.run.input,
                context,
              )) {
              }
            return {}
          } catch (error) {
            observedError = error
            throw error
          }
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw observedError ?? new Error("Final model never entered")
        }),
      ])
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {
        wait: false,
      })
      release.resolve()
      await host.idle()
      const row = (await f.snapshot(accepted.threadId)).runs[0]
      expect(calls).toBe(1)
      expect(row?.run.status).toBe(outcome)
      expect(row?.metadata.reason).toBe(outcome === "success" ? "completed" : "execution_error")
      if (outcome === "error")
        expect(String(observedError)).toContain("independent-native-model-failure")
      else expect(observedError).toBeUndefined()
    } finally {
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it.each(["execute", "stream"] as const)(
  "canonical %s observes Stop accepted before native binding without dispatching",
  async (mode) => {
    const f = await fixture(),
      prepared = deferred(),
      release = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      observedError: unknown
    class NeverModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "never-native-dispatched"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        throw new Error("Stopped invocation dispatched a first model")
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: NeverModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
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
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Never dispatch.",
            }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
          })
          prepared.resolve()
          await release.promise
          try {
            await bindProtocolAgentExecution({
              store,
              runId: run.run.run_id,
              checkpointer: saver,
              entry: graph,
              config: {
                configurable: {
                  thread_id: accepted.threadId,
                  checkpoint_ns: "",
                },
              },
            })
            if (mode === "execute") await agentBackendAdapter.execute(graph, run.run.input, context)
            else
              for await (const _chunk of agentBackendAdapter.stream(
                graph,
                run.run.input,
                context,
              )) {
              }
            return {}
          } catch (error) {
            observedError = error
            throw error
          }
        },
      })
      await host.tick()
      await prepared.promise
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {
        wait: false,
      })
      release.resolve()
      await host.idle()
      expect(calls).toBe(0)
      expect(isCooperativeStop(observedError)).toBe(true)
      const row = (await f.snapshot(accepted.threadId)).runs[0]
      expect(row?.metadata.reason).toBe("user_stop")
      expect(row?.run.status).toBe("interrupted")
    } finally {
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it("settles an already selected input checkpoint when Stop arrives inside its native superstep", async () => {
  const f = await fixture(),
    selected = deferred(),
    release = deferred()
  let host: ReturnType<typeof createExecutionHost> | undefined,
    calls = 0,
    observedError: unknown
  class NeverModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "selected-native-input"
    }
    bindTools() {
      return this
    }
    async _generate(): Promise<ChatResult> {
      calls++
      return {
        generations: [{ text: "unexpected", message: new AIMessage("unexpected") }],
      }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: NeverModel }))
  try {
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const service = createInputService({
      ...f.authority,
      resolveTarget: async ({ run }) => ({
        adapter: agentBackendAdapter,
        agentId: run.run.agent_id!,
        namespaceGeneration: run.run.run_id,
        systemInjection: false,
      }),
    })
    const receipt = await service.inject(f.request(), accepted.threadId, accepted.runId, {
      namespace: [],
      message: {
        id: "selected-steering",
        role: "user",
        content: "accepted steering",
        b4: { v: 1, submissionId: crypto.randomUUID() },
      },
    })
    host = createExecutionHost({
      ...f.authority,
      async invoke(context) {
        const { store, run } = context
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
          descriptor: agent({
            model: "gpt-5-mini",
            systemPrompt: "Selected input Stop.",
          }),
          checkpointer: saver,
          activeInput: {
            async beforeModel() {
              const input = await boundary.activeInput.beforeModel()
              selected.resolve()
              await release.promise
              return input
            },
          },
        })
        await bindProtocolAgentExecution({
          store,
          runId: run.run.run_id,
          checkpointer: saver,
          entry: graph,
          config: {
            configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
          },
        })
        try {
          await agentBackendAdapter.execute(graph, run.run.input, context)
          return {}
        } catch (error) {
          observedError = error
          throw error
        }
      },
    })
    await host.tick()
    await Promise.race([
      selected.promise,
      host.idle().then(() => {
        throw observedError ?? new Error("Input was not selected")
      }),
    ])
    await host.cancel(f.request(), accepted.threadId, accepted.runId, {
      wait: false,
    })
    release.resolve()
    await host.idle()
    expect(calls).toBe(0)
    expect(isCooperativeStop(observedError)).toBe(true)
    const snapshot = await f.snapshot(accepted.threadId)
    expect(snapshot.runs[0]?.metadata.reason).toBe("user_stop")
    expect(snapshot.inbox.find((row) => row.entryId === receipt.b4.receipt.inputId)?.status).toBe(
      "applied",
    )
    expect(
      (
        await service.inject(f.request(), accepted.threadId, accepted.runId, {
          namespace: [],
          message: {
            id: "selected-steering",
            role: "user",
            content: "accepted steering",
            b4: { v: 1, submissionId: receipt.b4.receipt.submissionId },
          },
        })
      ).b4.receipt.disposition,
    ).toBe("applied")
  } finally {
    release.resolve()
    await host?.close()
    await f.close()
  }
}, 30_000)

it.each(["execute", "stream"] as const)(
  "canonical %s keeps hard shutdown distinct from soft Stop",
  async (mode) => {
    const started = performance.now()
    const trace = (phase: string) => {
      if (process.env.B4_ADMISSION_TIMINGS === "1")
        console.info(
          "R8_NATIVE_HARD_PHASE",
          JSON.stringify({ mode, phase, elapsedMs: Math.round(performance.now() - started) }),
        )
    }
    trace("fixture-start")
    const f = await fixture(),
      entered = deferred(),
      hardObserved = deferred(),
      release = deferred(),
      toolFinished = deferred()
    trace("fixture-ready")
    let host: ReturnType<typeof createExecutionHost> | undefined,
      closing: Promise<void> | undefined,
      calls = 0,
      effects = 0,
      hardSignal: AbortSignal | undefined,
      softSignal: AbortSignal | undefined,
      lateWrite: (() => Promise<unknown>) | undefined
    class ToolModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "native-hard-shutdown"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        return {
          generations: [
            {
              text: "",
              message: new AIMessage({
                content: "",
                tool_calls: [{ id: "hard-effect", name: "effect", args: {} }],
              }),
            },
          ],
        }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ToolModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      trace("admitted")
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          trace("invocation-entered")
          const { store, run } = context
          softSignal = context.stopSignal
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
          lateWrite = () =>
            saver.put(
              {
                configurable: {
                  thread_id: accepted.threadId,
                  checkpoint_ns: "",
                },
              },
              emptyCheckpoint(),
              { source: "loop", step: 100, parents: {} },
              {},
            )
          const graph = await materializeAgentGraph({
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Hard channel.",
            }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "effect",
                description: "Hard channel effect.",
                async run(_input, ctx) {
                  trace("tool-entered")
                  hardSignal = ctx.signal
                  ctx.signal.addEventListener("abort", hardObserved.resolve, {
                    once: true,
                  })
                  entered.resolve()
                  try {
                    await release.promise
                    trace("tool-released")
                    effects++
                    return "effect completed"
                  } finally {
                    toolFinished.resolve()
                    trace("tool-finished")
                  }
                },
              },
            ],
          })
          trace("materialized")
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            },
          })
          trace("bound")
          try {
            if (mode === "execute") await agentBackendAdapter.execute(graph, run.run.input, context)
            else
              for await (const _chunk of agentBackendAdapter.stream(graph, run.run.input, context)) {
              }
          } finally {
            trace("native-invocation-settled")
          }
          return {}
        },
      })
      await host.tick()
      trace("tick-returned")
      await entered.promise
      trace("tool-observed")
      closing = host.close()
      trace("hard-close-requested")
      await hardObserved.promise
      trace("hard-abort-observed")
      expect(hardSignal?.aborted).toBe(true)
      expect(softSignal?.aborted).toBe(false)
      const boundary = await Promise.race([
        closing.then(() => "host-settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("host-pending"), 30)),
      ])
      const effectsBeforeRawRelease = effects
      trace("host-boundary-sampled")
      release.resolve()
      await toolFinished.promise
      trace("raw-tool-joined")
      await closing
      trace("host-closed")
      const settled = await f.snapshot(accepted.threadId)
      trace("terminal-checkpoint-read")
      console.info(
        "OWNED_NATIVE_HARD_BOUNDARY",
        JSON.stringify({
          mode,
          boundary,
          settledPhase: settled.runs[0]?.metadata.phase,
          settledReason: settled.runs[0]?.metadata.reason,
          effectsUncertain: settled.runs[0]?.metadata.effectsUncertain,
          unwound: settled.runs[0]?.unwoundAt !== undefined,
          effectsBeforeRawRelease,
          effectsAfterRawJoin: effects,
        }),
      )
      expect(settled.runs[0]?.metadata.effectsUncertain).toBe(true)
      expect(settled.runs[0]?.metadata.reason).toBe("server_shutdown")
      if (!lateWrite) throw new Error("Missing retained native saver")
      await expect(lateWrite()).rejects.toMatchObject({ code: "stale_fence" })
      trace("late-write-fenced")
      expect(await f.snapshot(accepted.threadId)).toEqual(settled)
      expect(calls).toBe(1)
      expect(effects).toBe(1)
    } finally {
      trace("cleanup-start")
      release.resolve()
      if (hardSignal) await toolFinished.promise
      await closing
      await host?.close()
      await f.close()
      trace("cleanup-complete")
    }
  },
  30_000,
)
