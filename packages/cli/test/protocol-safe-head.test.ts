import * as adapters from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { interrupt, MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { rebindStoppedCheckpoint } from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary, createInputService } from "../src/lib/runtime/inputs.ts"
import { parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"
import { rejectStoppedSourceFaults } from "./fixtures/protocol-source-faults.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))

it("rebinds a stopped real checkpoint without running its parked source task", async () => {
  let calls = 0,
    protectedActions = 0
  class ControlledModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "controlled-safe-head"
    }
    bindTools() {
      return this
    }
    async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
      calls++
      const message =
        calls === 1
          ? new AIMessage({
              content: "",
              tool_calls: [{ id: "protected-1", name: "protect", args: {} }],
            })
          : new AIMessage("fresh answer")
      return { generations: [{ text: "", message }] }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
  const graph = (await adapters.materializeAgentGraph({
    descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Safe." }),
    checkpointer: new MemorySaver(),
    tools: [
      {
        name: "protect",
        description: "Protected.",
        run: async () => {
          interrupt("permission required")
          protectedActions++
          return "protected effect"
        },
      },
    ],
  })) as {
    invoke(input: unknown, config: unknown): Promise<unknown>
    getState(config: unknown): Promise<{ next: string[]; tasks: unknown[] }>
  }
  const config = { configurable: { thread_id: "safe-head" }, durability: "sync" }
  await graph.invoke({ messages: [{ role: "user", content: "old proposal" }] }, config)
  expect((await graph.getState(config)).tasks.length).toBeGreaterThan(0)
  expect(protectedActions).toBe(0)
  expect(agentBackendAdapter?.protocol?.rebindCheckpoint).toBeTypeOf("function")
  const rebound = await agentBackendAdapter.protocol!.rebindCheckpoint!(graph, config)
  expect((await graph.getState(rebound)).next).toEqual([])
  expect(protectedActions).toBe(0)
  expect(calls).toBe(1)
  await graph.invoke({ messages: [{ role: "user", content: "fresh independent turn" }] }, rebound)
  expect(protectedActions).toBe(0)
  expect(calls).toBe(2)
}, 30_000)

it("safely rebinds an accepted fresh Run canceled before dispatch on a completed source head", async () => {
  const f = await fixture()
  let host: ReturnType<typeof createExecutionHost> | undefined,
    calls = 0,
    failure: unknown
  class ControlledModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "canceled-new-turn"
    }
    bindTools() {
      return this
    }
    async _generate(): Promise<ChatResult> {
      calls++
      return { generations: [{ text: "done", message: new AIMessage("done") }] }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
  const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Selected source." })
  try {
    const initial = await f.admit(body({ on_completion: "keep" }))
    host = createExecutionHost({
      ...f.authority,
      async invoke({ store, run }) {
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
          const graph = (await adapters.materializeAgentGraph({
            descriptor,
            checkpointer: saver,
            activeInput: boundary.activeInput,
          })) as { invoke(input: unknown, config: unknown): Promise<unknown> }
          await graph.invoke(run.run.input, {
            configurable: { thread_id: initial.threadId, checkpoint_ns: "" },
            durability: "sync",
          })
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
    f.defaultAgent("/other#agent")
    const canceled = await f.admit(
      body({
        thread_id: initial.threadId,
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        on_completion: "keep",
      }),
    )
    await host.cancel(f.request(), initial.threadId, canceled.runId, { wait: true })
    const store = await f.store(initial.threadId),
      before = await store.snapshot()
    expect(
      before.runs.find((row) => row.run.run_id === canceled.runId)?.metadata.startedAt,
    ).toBeUndefined()
    const saver = createRuntimeCheckpointSaver({ store, runId: canceled.runId, namespace: [] })
    const graph = await adapters.materializeAgentGraph({
      descriptor,
      checkpointer: saver,
      activeInput: createActiveInputBoundary({
        store,
        runId: canceled.runId,
        namespace: [],
        namespaceGeneration: canceled.runId,
      }).activeInput,
    })
    const options = {
      ...f.authority,
      request: f.request(),
      store,
      runId: canceled.runId,
      checkpointer: saver,
      adapter: agentBackendAdapter,
      entry: graph,
      config: {
        configurable: { thread_id: initial.threadId, checkpoint_ns: "" },
        durability: "sync",
      },
    }
    f.removeAgent("/chat#agent")
    await expect(rebindStoppedCheckpoint(options)).rejects.toMatchObject({ code: "not_found" })
    expect(await store.snapshot()).toEqual(before)
    f.restoreAgent("/chat#agent")
    const fault = new Error("accepted-initial-rebind-rollback")
    await expect(
      rebindStoppedCheckpoint({
        ...options,
        failpoint() {
          throw fault
        },
      }),
    ).rejects.toBe(fault)
    expect(await store.snapshot()).toEqual(before)
    const oldConfig = {
      configurable: {
        thread_id: initial.threadId,
        checkpoint_ns: "",
        checkpoint_id: before.thread!.headCheckpointId!,
      },
    }
    await expect(
      saver.putWrites(oldConfig, [["_b4AppliedInputIds", []]], "after-rollback"),
    ).rejects.toMatchObject({ code: "stale_generation" })
    expect(await store.snapshot()).toEqual(before)
    await rebindStoppedCheckpoint(options)
    const committed = await store.snapshot()
    await expect(
      saver.putWrites(oldConfig, [["_b4AppliedInputIds", []]], "after-commit"),
    ).rejects.toMatchObject({ code: "stale_generation" })
    expect(await store.snapshot()).toEqual(committed)
    const source = committed.checkpoints.find(
      (row) => row.state.checkpoint.checkpoint_id === oldConfig.configurable.checkpoint_id,
    )!
    expect(source.ownerRunId).toBe(initial.runId)
    expect(
      (
        source.payload as {
          writes: {
            ownerRunId: string
            sourceCheckpointId: string | null
            taskId: string
            index: number
          }[]
        }
      ).writes.filter((write) => write.ownerRunId === canceled.runId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceCheckpointId: source.state.checkpoint.checkpoint_id,
          taskId: expect.any(String),
          index: expect.any(Number),
        }),
      ]),
    )
    expect(calls).toBe(1)
    await rejectStoppedSourceFaults(f, initial.threadId, store)
    // Another new turn selects the certified null-owner safe revision, then
    // stops before dispatch too. Its creator has no previousRunId linkage.
    const queued = await f.admit(
      body({
        thread_id: initial.threadId,
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        on_completion: "keep",
      }),
    )
    await host.cancel(f.request(), initial.threadId, queued.runId, { wait: true })
    const selected = await store.snapshot(),
      selectedHead = selected.checkpoints.find(
        (row) => row.state.checkpoint.checkpoint_id === selected.thread?.headCheckpointId,
      )!
    expect(selectedHead.ownerRunId).toBeNull()
    expect(
      selected.runs.find((row) => row.run.run_id === queued.runId)?.metadata.previousRunId,
    ).toBeUndefined()
    const queuedSaver = createRuntimeCheckpointSaver({ store, runId: queued.runId, namespace: [] })
    const queuedGraph = await adapters.materializeAgentGraph({
      descriptor,
      checkpointer: queuedSaver,
      activeInput: createActiveInputBoundary({
        store,
        runId: queued.runId,
        namespace: [],
        namespaceGeneration: queued.runId,
      }).activeInput,
    })
    await rebindStoppedCheckpoint({
      ...options,
      runId: queued.runId,
      checkpointer: queuedSaver,
      entry: queuedGraph,
    })
    expect(calls).toBe(1)
    const freshToken = crypto.randomUUID()
    const fresh = await f.admit(
      body({
        thread_id: initial.threadId,
        metadata: { b4: { v: 1, submissionId: freshToken } },
        on_completion: "keep",
      }),
    )
    await host.tick()
    await host.idle()
    if (failure) throw failure
    expect(
      (await f.snapshot(initial.threadId)).runs.find((row) => row.run.run_id === fresh.runId)?.run
        .status,
    ).toBe("success")
    expect(calls).toBe(2)
    const generation = (await f.snapshot(initial.threadId)).scope.generation
    for (const runId of [initial.runId, canceled.runId, queued.runId])
      await f.native.removeLiveRunPayload(initial.threadId, generation, runId)
    expect(await f.lookup(freshToken)).toHaveLength(1)
    f.removeAgent("/chat#agent")
    expect(await f.lookup(freshToken)).toEqual([])
    await f.native.corruptProtectedSourceDigest(initial.threadId, generation, fresh.runId)
    expect(await f.lookup(freshToken)).toEqual([])
    f.restoreAgent("/chat#agent")
    await expect(f.lookup(freshToken)).rejects.toMatchObject({ code: "storage_unavailable" })
  } finally {
    await host?.close()
    await f.close()
  }
}, 30_000)

it.each([false, true])(
  "atomically rebinds the actual stopped checkpoint and grants before a fresh Run (prior input %s)",
  async (priorInput) => {
    const f = await fixture()
    let host: ReturnType<typeof createExecutionHost> | undefined
    let calls = 0,
      protectedActions = 0
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "durable-safe-head"
      }
      bindTools() {
        return this
      }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        const message =
          priorInput && calls === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "inspect-first", name: "inspect", args: {} }],
              })
            : calls === (priorInput ? 2 : 1)
              ? new AIMessage({
                  content: "",
                  tool_calls: [{ id: "retired-proposal", name: "protect", args: {} }],
                })
              : new AIMessage("fresh answer")
        return { generations: [{ text: "", message }] }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Durable safe head." })
    let injectDuringTool: (() => Promise<unknown>) | undefined
    const tools = [
      {
        name: "protect",
        description: "Protected.",
        run: async () => {
          interrupt("permission required")
          protectedActions++
          return "protected"
        },
      },
      {
        name: "inspect",
        description: "Inspect.",
        run: async () => {
          await injectDuringTool?.()
          return "observed"
        },
      },
    ]
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
      injectDuringTool = () =>
        service.inject(f.request(), accepted.threadId, accepted.runId, {
          namespace: [],
          message: {
            role: "user",
            content: "applied before stop",
            b4: { v: 1, submissionId: crypto.randomUUID() },
          },
        })
      const config = {
        configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
        durability: "sync",
      }
      host = createExecutionHost({
        ...f.authority,
        async invoke({ store, run }) {
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
          const graph = (await adapters.materializeAgentGraph({
            descriptor,
            checkpointer,
            tools,
            activeInput: boundary.activeInput,
          })) as { invoke(input: unknown, config: unknown): Promise<unknown> }
          await graph.invoke(run.run.input, config)
          if (run.run.run_id === accepted.runId)
            await store.transaction((tx) =>
              parkPermissions(
                tx,
                run.run.run_id,
                [
                  {
                    interruptId: "source-permission",
                    namespace: [],
                    request: {
                      kind: "tool",
                      detail: { toolName: "protect", suggestedPattern: "protect" },
                    },
                    protectedProposal: { tool: "protect", args: {} },
                  },
                ],
                "required",
              ),
            )
          return {}
        },
      })
      await host.tick()
      await host.idle()
      await host.cancel(f.request(), accepted.threadId, accepted.runId, {})
      await expect(
        f.admit(
          body({
            thread_id: accepted.threadId,
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
            on_completion: "keep",
          }),
        ),
      ).rejects.toMatchObject({ code: "not_supported" })
      expect((await f.snapshot(accepted.threadId)).runs).toHaveLength(1)
      const store = await f.store(accepted.threadId),
        before = await store.snapshot()
      const checkpointer = createRuntimeCheckpointSaver({
        store,
        runId: accepted.runId,
        namespace: [],
      })
      const graph = await adapters.materializeAgentGraph({
        descriptor,
        checkpointer,
        tools,
        activeInput: createActiveInputBoundary({
          store,
          runId: accepted.runId,
          namespace: [],
          namespaceGeneration: accepted.runId,
        }).activeInput,
      })
      await expect(
        rebindStoppedCheckpoint({
          ...f.authority,
          request: f.request(),
          store,
          runId: accepted.runId,
          checkpointer,
          adapter: {
            kind: "graph",
            async execute() {
              throw new Error("Unsupported adapter executed")
            },
            stream() {
              throw new Error("Unsupported adapter streamed")
            },
          },
          entry: graph,
          config,
        }),
      ).rejects.toMatchObject({ code: "not_supported" })
      expect(await store.snapshot()).toEqual(before)
      const fault = new Error("rebind-before-commit")
      await expect(
        rebindStoppedCheckpoint({
          ...f.authority,
          request: f.request(),
          store,
          runId: accepted.runId,
          checkpointer,
          adapter: agentBackendAdapter,
          entry: graph,
          config,
          failpoint() {
            throw fault
          },
        }),
      ).rejects.toBe(fault)
      expect(await store.snapshot()).toEqual(before)
      expect(calls).toBe(priorInput ? 2 : 1)
      expect(protectedActions).toBe(0)
      const rebound = await rebindStoppedCheckpoint({
        ...f.authority,
        request: f.request(),
        store,
        runId: accepted.runId,
        checkpointer,
        adapter: agentBackendAdapter,
        entry: graph,
        config,
      })
      const after = await store.snapshot()
      expect(after.thread?.headCheckpointId).not.toBe(before.thread?.headCheckpointId)
      expect(
        after.checkpoints.find(
          (row) => row.state.checkpoint.checkpoint_id === after.thread?.headCheckpointId,
        )?.ownerRunId,
      ).toBeNull()
      expect(after.pending.every((row) => row.disposition === "retired")).toBe(true)
      expect(after.grants.filter((row) => row.consumedByRunId !== null)).toEqual([])
      expect(calls).toBe(priorInput ? 2 : 1)
      expect(protectedActions).toBe(0)
      const fresh = await f.admit(
        body({
          thread_id: accepted.threadId,
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
          input: { messages: [{ role: "user", content: "fresh turn" }] },
          on_completion: "keep",
        }),
      )
      expect(fresh.runId).not.toBe(accepted.runId)
      await host.tick()
      await host.idle()
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === fresh.runId)
          ?.run.status,
      ).toBe("success")
      expect(calls).toBe(priorInput ? 3 : 2)
      expect(protectedActions).toBe(0)
      expect(rebound).toHaveProperty("configurable.checkpoint_id")
    } finally {
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
