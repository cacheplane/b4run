import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent, isCooperativeStop } from "@b4run/sdk"
import type { RuntimeStore } from "@b4run/sdk/agent-protocol"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
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
  injectionPayload,
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
                    return await owned.invoke(
                      { messages: [{ role: "user", content: "child" }] },
                      config,
                    )
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
              for await (const _chunk of agentBackendAdapter.stream(
                graph,
                run.run.input,
                context,
              )) {
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

const beforeModelControlCases = [
  { mode: "execute", observation: "no-stop" },
  { mode: "stream", observation: "no-stop" },
  { mode: "execute", observation: "not-yet-observed" },
  { mode: "stream", observation: "not-yet-observed" },
  { mode: "execute", observation: "owner-observed" },
  { mode: "stream", observation: "owner-observed" },
] as const

it.each(beforeModelControlCases)(
  "canonical $mode preserves before-model outcome truth when Stop is $observation",
  async ({ mode, observation }) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    let owner: ReturnType<typeof createExecutionHost> | undefined,
      replica: ReturnType<typeof createExecutionHost> | undefined,
      ownerStore: RuntimeStore | undefined,
      hardSignal: AbortSignal | undefined,
      softSignal: AbortSignal | undefined,
      calls = 0,
      replicaInvocations = 0,
      controlId: string | undefined,
      observedError: unknown
    class BeforeModelReply extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "replica-stop-before-model"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        calls++
        return {
          generations: [{ text: "natural reply", message: new AIMessage("natural reply") }],
        }
      }
      async *_streamResponseChunks() {
        const result = await this._generate()
        yield new ChatGenerationChunk({
          text: "natural reply",
          message: new AIMessageChunk({ content: result.generations[0]!.message.content }),
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: BeforeModelReply }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      owner = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
          ownerStore = store
          hardSignal = context.signal
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
          const graph = await materializeAgentGraph({
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Finish one model turn." }),
            checkpointer: saver,
            activeInput: {
              async beforeModel() {
                entered.resolve()
                await release.promise
                // The replica accepts Stop BEFORE the real boundary reads the inbox.
                return boundary.activeInput.beforeModel()
              },
            },
          })
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: { configurable: { thread_id: accepted.threadId, checkpoint_ns: "" } },
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
      replica = createExecutionHost({
        ...f.authority,
        async invoke() {
          replicaInvocations++
          throw new Error("The API replica must never own this invocation")
        },
      })
      // tick() dispatches once; start() is deliberately not called. This models
      // the legal window after a replica's acceptance and before the next owner poll.
      await owner.tick()
      await Promise.race([
        entered.promise,
        owner.idle().then(() => {
          throw observedError ?? new Error("Native before-model boundary was not reached")
        }),
      ])
      const authority = async () => {
        if (!ownerStore) throw new Error("No owned native store")
        return ownerStore.transaction(async (tx) => {
          const run = await tx.runs.get(accepted.runId)
          return {
            generation: tx.scope.generation,
            fence: tx.scope.fence,
            ownerId: await tx.executionOwner(),
            currentRunId: (await tx.thread.get())?.currentRunId,
            execution: run?.execution,
            phase: run?.metadata.phase,
          }
        })
      }
      const before = await authority()
      expect(before).toMatchObject({
        ownerId: owner.ownerId,
        currentRunId: accepted.runId,
        phase: "running",
      })
      expect(before.execution).toMatchObject({ ownerId: owner.ownerId, fence: before.fence })
      expect(hardSignal?.aborted).toBe(false)
      expect(softSignal?.aborted).toBe(false)
      if (observation !== "no-stop") {
        await replica.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
        expect(await authority()).toEqual(before)
        expect(replicaInvocations).toBe(0)
        expect(hardSignal?.aborted).toBe(false)
        expect(softSignal?.aborted).toBe(false)
        const durable = await f.snapshot(accepted.threadId)
        const controls = durable.inbox.filter(
          (row) => row.kind === "control" && row.runId === accepted.runId,
        )
        expect(controls).toHaveLength(1)
        expect(controls).toMatchObject([
          { status: "accepted", payload: { generation: before.generation, reason: "user_stop" } },
        ])
        controlId = controls[0]!.entryId
      }
      if (observation === "owner-observed") {
        await owner.tick()
        expect(softSignal?.aborted).toBe(true)
        expect(hardSignal?.aborted).toBe(false)
        expect(await authority()).toEqual(before)
      }
      expect(calls).toBe(0)
      release.resolve()
      await owner.idle()
      const snapshot = await f.snapshot(accepted.threadId)
      const row = snapshot.runs.find((run) => run.run.run_id === accepted.runId)
      expect(replicaInvocations).toBe(0)
      expect(hardSignal?.aborted).toBe(false)
      if (observation === "owner-observed") {
        expect(row?.metadata.reason).toBe("user_stop")
        expect(calls).toBe(0)
        expect(isCooperativeStop(observedError)).toBe(true)
      } else {
        expect(row?.metadata.reason).toBe("completed")
        expect(calls).toBe(1)
        expect(observedError).toBeUndefined()
        expect(softSignal?.aborted).toBe(false)
      }
      expect(row?.run.status).toBe(observation === "owner-observed" ? "interrupted" : "success")
      expect(row?.metadata.phase).toBe("settled")
      expect(row?.metadata.continuation).toBe("closed")
      expect(row?.metadata.effectsUncertain).not.toBe(true)
      expect(row?.unwoundAt).toBeTruthy()
      expect(snapshot.thread?.currentRunId).toBe(accepted.runId)
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).toBeNull()
      const controls = snapshot.inbox.filter(
        (entry) => entry.kind === "control" && entry.runId === accepted.runId,
      )
      expect(controls).toHaveLength(observation === "no-stop" ? 0 : 1)
      if (observation === "no-stop") expect(controls).toEqual([])
      else
        expect(controls).toMatchObject([
          {
            entryId: controlId,
            status: "applied",
            payload: { generation: before.generation, reason: "user_stop" },
          },
        ])
    } finally {
      release.resolve()
      try {
        await owner?.idle()
      } finally {
        try {
          await owner?.close()
        } finally {
          try {
            await replica?.close()
          } finally {
            await f.close()
          }
        }
      }
    }
  },
  30_000,
)

it.each(["execute", "stream"] as const)(
  "canonical %s applies queued exact-run FIFO input when Stop is observed before selection",
  async (mode) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      hardSignal: AbortSignal | undefined,
      softSignal: AbortSignal | undefined,
      observedError: unknown
    class NeverModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "preselection-fifo-native-input"
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
      const params = (label: string) => ({
        namespace: [],
        message: {
          id: label,
          role: "user" as const,
          content: label,
          b4: { v: 1 as const, submissionId: crypto.randomUUID() },
        },
      })
      const submissions = [params("fifo-first"), params("fifo-second")]
      const receipts = [
        await service.inject(f.request(), accepted.threadId, accepted.runId, submissions[0]!),
        await service.inject(f.request(), accepted.threadId, accepted.runId, submissions[1]!),
      ]
      const inputIds = receipts.map((receipt) => receipt.b4.receipt.inputId)
      host = createExecutionHost({
        ...f.authority,
        async invoke(context) {
          const { store, run } = context
          hardSignal = context.signal
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
          const graph = await materializeAgentGraph({
            descriptor: agent({
              model: "gpt-5-mini",
              systemPrompt: "Complete the owned input-selection superstep.",
            }),
            checkpointer: saver,
            activeInput: {
              async beforeModel() {
                entered.resolve()
                await release.promise
                return boundary.activeInput.beforeModel()
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
          throw observedError ?? new Error("Native preselection boundary was not reached")
        }),
      ])
      // This separate, genuinely admitted Run remains undispatched: tick() has
      // already returned and cancel() only observes the current owner's live work.
      const other = await f.admit(
        body({
          on_completion: "keep",
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      )
      expect(other.threadId).not.toBe(accepted.threadId)
      expect(other.runId).not.toBe(accepted.runId)
      const otherReceipt = await service.inject(
        f.request(),
        other.threadId,
        other.runId,
        params("other-run-input"),
      )
      const otherBefore = await f.snapshot(other.threadId)
      expect(hardSignal?.aborted).toBe(false)
      expect(softSignal?.aborted).toBe(false)
      await host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
      expect(softSignal?.aborted).toBe(true)
      expect(hardSignal?.aborted).toBe(false)
      const held = await f.snapshot(accepted.threadId)
      expect(held.runs.find((row) => row.run.run_id === accepted.runId)?.metadata.phase).toBe(
        "running",
      )
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).toBe(host.ownerId)
      expect(
        held.inbox.filter((row) => inputIds.includes(row.entryId)).map((row) => row.status),
      ).toEqual(["accepted", "accepted"])
      release.resolve()
      await host.idle()
      expect(calls).toBe(0)
      expect(isCooperativeStop(observedError)).toBe(true)
      expect(hardSignal?.aborted).toBe(false)
      const snapshot = await f.snapshot(accepted.threadId)
      const row = snapshot.runs.find((run) => run.run.run_id === accepted.runId)
      expect(row).toMatchObject({
        run: { status: "interrupted" },
        metadata: { reason: "user_stop", phase: "settled", continuation: "closed" },
      })
      expect(row?.unwoundAt).toBeTruthy()
      const applied = snapshot.inbox.filter((entry) => entry.kind === "inject")
      expect(applied).toHaveLength(inputIds.length)
      for (const entryId of inputIds)
        expect(applied.find((entry) => entry.entryId === entryId)).toMatchObject({
          entryId,
          runId: accepted.runId,
          namespace: [],
          status: "applied",
        })
      const restored = createRuntimeCheckpointSaver({
        store: await f.store(accepted.threadId),
        runId: accepted.runId,
        namespace: [],
      })
      const tuple = await restored.getTuple({
        configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
      })
      expect(tuple?.checkpoint.channel_values._b4AppliedInputIds).toEqual(inputIds)
      const messages = tuple?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw new Error("Missing actual native checkpoint messages")
      expect(messages.map((message) => message.id).filter((id) => inputIds.includes(id))).toEqual(
        inputIds,
      )
      expect(messages.some((message) => message.id === otherReceipt.b4.receipt.inputId)).toBe(false)
      for (const [index, submission] of submissions.entries())
        expect(
          (await service.inject(f.request(), accepted.threadId, accepted.runId, submission)).b4
            .receipt,
        ).toMatchObject({ inputId: inputIds[index], disposition: "applied" })
      expect(await f.snapshot(other.threadId)).toEqual(otherBefore)
      expect(
        otherBefore.inbox.find((entry) => entry.entryId === otherReceipt.b4.receipt.inputId),
      ).toMatchObject({ runId: other.runId, namespace: [], status: "accepted" })
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).toBeNull()
    } finally {
      release.resolve()
      try {
        await host?.idle()
      } finally {
        try {
          await host?.close()
        } finally {
          await f.close()
        }
      }
    }
  },
  30_000,
)

it.each(["execute", "stream"] as const)(
  "canonical %s preserves omitted, empty and nonempty injected names at the model and checkpoint",
  async (mode) => {
    const f = await fixture()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      observedError: unknown
    const submissions = (["user", "system"] as const).flatMap((role) =>
      [undefined, "", "reviewer"].map((name, index) => ({
        namespace: [],
        message: {
          role,
          content: `${role}-name-${index}`,
          ...(name !== undefined ? { name } : {}),
          b4: { v: 1 as const, submissionId: crypto.randomUUID() },
        },
      })),
    )
    const inputIds: string[] = []
    const view = (
      messages: readonly {
        readonly id?: unknown
        readonly content?: unknown
        readonly name?: unknown
      }[],
    ) =>
      inputIds.map((id) => {
        const message = messages.find((message) => message.id === id)
        if (!message) throw new Error("Missing exact injected message")
        return { id, content: message.content, name: message.name }
      })
    let modelMessages: ReturnType<typeof view> = [],
      modelTypes: string[] = [],
      modelDispositions: unknown[] = []
    class NamedInputModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "canonical-named-input"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        modelMessages = view(messages)
        modelTypes = inputIds.map((id) => {
          const message = messages.find((message) => message.id === id)
          if (!message) throw new Error("Model missed an exact injected message")
          return message.getType()
        })
        modelDispositions = await Promise.all(
          submissions.map(async ({ message }) => {
            const result = await f.lookup(message.b4.submissionId)
            return result[0]?.metadata.b4
          }),
        )
        return { generations: [{ text: "done", message: new AIMessage("done") }] }
      }
      async *_streamResponseChunks(messages: BaseMessage[]) {
        await this._generate(messages)
        yield new ChatGenerationChunk({ text: "done", message: new AIMessageChunk("done") })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: NamedInputModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      const service = createInputService({
        ...f.authority,
        authorizeSystemInput: async () => true,
        resolveTarget: async ({ run }) => ({
          adapter: agentBackendAdapter,
          agentId: run.run.agent_id!,
          namespaceGeneration: run.run.run_id,
          systemInjection: true,
        }),
      })
      const acceptedReceipts = []
      for (const submission of submissions) {
        const receipt = await service.inject(
          f.request(),
          accepted.threadId,
          accepted.runId,
          submission,
        )
        const inputId = receipt.b4.receipt.inputId
        if (typeof inputId !== "string") throw new Error("Missing accepted input identity")
        inputIds.push(inputId)
        acceptedReceipts.push(receipt.b4.receipt)
      }
      const acceptedReplays = []
      for (const submission of submissions)
        acceptedReplays.push(
          (await service.inject(f.request(), accepted.threadId, accepted.runId, submission)).b4
            .receipt,
        )
      const acceptedSnapshot = await f.snapshot(accepted.threadId)
      const acceptedMessages = inputIds.map((id) => {
        const row = acceptedSnapshot.inbox.find((row) => row.entryId === id)
        if (!row) throw new Error("Missing accepted durable input")
        return injectionPayload(row).message
      })
      // Reject invalid wire names and changed names under the same token.
      // These existing authority/identity checks must not mutate the accepted cut.
      for (const role of ["user", "system"])
        for (const name of [null, 7, {}, []])
          await expect(
            service.inject(f.request(), accepted.threadId, accepted.runId, {
              namespace: [],
              message: { role, content: "invalid-name", name },
            }),
          ).rejects.toMatchObject({ code: "invalid_argument" })
      for (const submission of submissions)
        await expect(
          service.inject(f.request(), accepted.threadId, accepted.runId, {
            ...submission,
            message: { ...submission.message, name: "changed-name" },
          }),
        ).rejects.toMatchObject({ code: "submission_conflict" })
      expect(await f.snapshot(accepted.threadId)).toEqual(acceptedSnapshot)
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
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Apply the named inputs." }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
          })
          await bindProtocolAgentExecution({
            store,
            runId: run.run.run_id,
            checkpointer: saver,
            entry: graph,
            config: { configurable: { thread_id: accepted.threadId, checkpoint_ns: "" } },
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
      await host.idle()
      const appliedSnapshot = await f.snapshot(accepted.threadId)
      const restoredSaver = createRuntimeCheckpointSaver({
        store: await f.store(accepted.threadId),
        runId: accepted.runId,
        namespace: [],
      })
      const restored = await restoredSaver.getTuple({
        configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
      })
      const checkpointMessages = restored?.checkpoint.channel_values.messages
      if (!Array.isArray(checkpointMessages)) throw new Error("Missing saved native messages")
      const appliedReplays = []
      for (const submission of submissions)
        appliedReplays.push(
          (await service.inject(f.request(), accepted.threadId, accepted.runId, submission)).b4
            .receipt,
        )
      const expected = submissions.map(({ message }, index) => ({
        id: inputIds[index],
        content: message.content,
        name: message.name,
      }))
      expect(observedError).toBeUndefined()
      expect(calls).toBe(1)
      expect(modelTypes).toEqual(["human", "human", "human", "system", "system", "system"])
      for (const [index, receipt] of acceptedReceipts.entries()) {
        expect(receipt).toMatchObject({
          inputId: inputIds[index],
          runId: accepted.runId,
          disposition: "accepted",
        })
        expect(acceptedReplays[index]).toEqual({ ...receipt, replayed: true })
        expect(appliedReplays[index]).toEqual({
          ...receipt,
          disposition: "applied",
          replayed: true,
        })
        expect(modelDispositions[index]).toMatchObject({
          lookup: {
            receipt: { inputId: inputIds[index], runId: accepted.runId, disposition: "applied" },
          },
        })
      }
      for (const inputId of inputIds)
        expect(appliedSnapshot.inbox.find((row) => row.entryId === inputId)).toMatchObject({
          runId: accepted.runId,
          namespace: [],
          status: "applied",
        })
      expect(restored?.checkpoint.channel_values._b4AppliedInputIds).toEqual(inputIds)
      expect(
        checkpointMessages
          .filter((message) => inputIds.includes(message.id))
          .map((message) => message.id),
      ).toEqual(inputIds)
      expect(appliedSnapshot.runs.find((row) => row.run.run_id === accepted.runId)).toMatchObject({
        run: { status: "success" },
        metadata: { phase: "settled", reason: "completed", continuation: "closed" },
      })
      expect(
        await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
      ).toBeNull()
      // Collect every actual accepted/model/native restored/public/applied observation
      // before this aggregate oracle, so an early empty-name loss cannot mask
      // the independent native conversion loss for both roles.
      expect({
        accepted: view(acceptedMessages),
        acceptedNameKeys: acceptedMessages.map((message) => Object.hasOwn(message, "name")),
        model: modelMessages,
        checkpoint: view(checkpointMessages),
        publicMessages: view(appliedSnapshot.thread?.thread.messages ?? []),
      }).toEqual({
        accepted: expected,
        acceptedNameKeys: [false, true, true, false, true, true],
        model: expected,
        checkpoint: expected,
        publicMessages: expected,
      })
    } finally {
      try {
        await host?.idle()
      } finally {
        try {
          await host?.close()
        } finally {
          await f.close()
        }
      }
    }
  },
  30_000,
)
