import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent, type BackendActiveInput } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { interrupt } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary, createInputService } from "../src/lib/runtime/inputs.ts"
import { parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))
const params = (token = crypto.randomUUID(), role = "user", content = "recover this steering") => ({
  namespace: [],
  message: { role, content, b4: { v: 1, submissionId: token } },
})

it.each(["finish", "park", "stop", "returnDirect"] as const)(
  "retains input as not_applied when %s wins before another eligible model",
  async (mode) => {
    const f = await fixture(),
      token = crypto.randomUUID()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      cancellation: Promise<void> | undefined
    let inject!: () => Promise<unknown>,
      calls = 0,
      effects = 0
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "controlled-terminal-boundary"
      }
      bindTools() {
        return this
      }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        if (mode !== "returnDirect") await inject()
        const message =
          mode === "park" || mode === "returnDirect"
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "terminal-tool", name: "terminal", args: {} }],
              })
            : new AIMessage("finished")
        return { generations: [{ text: "", message }] }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
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
      inject = async () => {
        const result = await service.inject(
          f.request(),
          accepted.threadId,
          accepted.runId,
          params(token),
        )
        expect(result.b4.receipt.disposition).toBe("accepted")
        if (mode === "stop") {
          // Establish the durable first winner before this model returns. Waiting
          // for unwind here would wait on this very provider promise.
          await host!.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
          cancellation = host!.cancel(f.request(), accepted.threadId, accepted.runId, {
            wait: true,
          })
        }
      }
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
          })
          const graph = (await materializeAgentGraph({
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Terminal." }),
            checkpointer,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "terminal",
                description: "Terminal boundary.",
                returnDirect: mode === "returnDirect",
                run: async () => {
                  if (mode === "park") interrupt("permission required")
                  else {
                    await inject()
                    effects++
                  }
                  return "terminal result"
                },
              },
            ],
          })) as {
            invoke(input: unknown, config: unknown): Promise<unknown>
            getState(config: unknown): Promise<{
              config: { configurable: { checkpoint_id: string } }
              tasks: { id: string; interrupts: { id: string }[] }[]
            }>
          }
          const config = {
            configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            signal,
            durability: "sync",
          }
          await graph.invoke(run.run.input, config)
          if (mode === "park") {
            const state = await graph.getState(config),
              task = state.tasks.find((task) => task.interrupts.length)
            if (!task?.interrupts[0]) throw new Error("Missing actual native permission task")
            await store.transaction((tx) =>
              parkPermissions(
                tx,
                run.run.run_id,
                [
                  {
                    interruptId: task.interrupts[0]!.id,
                    namespace: [],
                    request: {
                      kind: "tool",
                      detail: { toolName: "terminal", suggestedPattern: "terminal" },
                    },
                    protectedProposal: {
                      tool: "terminal",
                      nativeTaskId: task.id,
                      nativeInterruptId: task.interrupts[0]!.id,
                      checkpointId: state.config.configurable.checkpoint_id,
                    },
                  },
                ],
                "required",
              ),
            )
          }
          return {}
        },
      })
      await host.tick()
      await host.idle()
      await cancellation
      const snapshot = await f.snapshot(accepted.threadId),
        entry = snapshot.inbox.find((row) => row.kind === "inject")
      expect(calls).toBe(1)
      expect(effects).toBe(mode === "returnDirect" ? 1 : 0)
      expect(entry).toMatchObject({
        runId: accepted.runId,
        status: "not_applied",
        payload: { message: { content: "recover this steering" } },
      })
      const replayed = await service.inject(
        f.request(),
        accepted.threadId,
        accepted.runId,
        params(token),
      )
      expect(replayed.b4.receipt).toMatchObject({
        disposition: "not_applied",
        inputId: entry?.entryId,
        reason: mode === "park" ? "permission" : mode === "stop" ? "user_stop" : "completed",
        replayed: true,
      })
      const journal = await (await f.store(accepted.threadId)).transaction((tx) =>
        tx.journal.read(0),
      )
      expect(
        journal.filter((row) => JSON.stringify(row.event).includes('"disposition":"applied"')),
      ).toEqual([])
      if (mode === "park") {
        expect(snapshot.pending.every((row) => row.disposition === "pending")).toBe(true)
        expect(snapshot.grants.every((row) => row.consumedByRunId === null)).toBe(true)
      }
    } finally {
      await cancellation
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it("rolls back the injected checkpoint and applied receipt together before any model call", async () => {
  const f = await fixture(),
    token = crypto.randomUUID()
  let host: ReturnType<typeof createExecutionHost> | undefined,
    calls = 0,
    armed = false,
    fault = false
  class ControlledModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "controlled-checkpoint-fault"
    }
    bindTools() {
      return this
    }
    async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
      calls++
      return { generations: [{ text: "", message: new AIMessage("finished") }] }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
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
    const receipt = await service.inject(
      f.request(),
      accepted.threadId,
      accepted.runId,
      params(token),
    )
    host = createExecutionHost({
      ...f.authority,
      async invoke({ store, run, signal }) {
        const boundary = createActiveInputBoundary({
          store,
          runId: run.run.run_id,
          namespace: [],
          namespaceGeneration: run.run.run_id,
        })
        const activeInput: BackendActiveInput = {
          async beforeModel() {
            const selected = await boundary.activeInput.beforeModel()
            armed = !!selected
            return selected
          },
        }
        const checkpointer = createRuntimeCheckpointSaver({
          store,
          runId: run.run.run_id,
          namespace: [],
          commitInputs: boundary.commitInputs,
          failpoint(point) {
            if (armed && point === "afterCheckpoint") {
              fault = true
              throw new Error("checkpoint-before-applied-fault")
            }
          },
        })
        const graph = (await materializeAgentGraph({
          descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Fault." }),
          checkpointer,
          activeInput,
        })) as { invoke(input: unknown, config: unknown): Promise<unknown> }
        await graph.invoke(run.run.input, {
          configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
          signal,
          durability: "sync",
        })
        return {}
      },
    })
    await host.tick()
    await host.idle()
    expect(fault).toBe(true)
    expect(calls).toBe(0)
    const snapshot = await f.snapshot(accepted.threadId)
    expect(snapshot.inbox.find((row) => row.entryId === receipt.b4.receipt.inputId)?.status).toBe(
      "not_applied",
    )
    expect(
      (await service.inject(f.request(), accepted.threadId, accepted.runId, params(token))).b4
        .receipt,
    ).toMatchObject({ disposition: "not_applied", reason: "execution_error" })
    const journal = await (await f.store(accepted.threadId)).transaction((tx) => tx.journal.read(0))
    expect(
      journal.filter((row) => JSON.stringify(row.event).includes('"disposition":"applied"')),
    ).toEqual([])
    const restored = createRuntimeCheckpointSaver({
      store: await f.store(accepted.threadId),
      runId: accepted.runId,
      namespace: [],
    })
    expect(
      (
        await restored.getTuple({
          configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
        })
      )?.checkpoint.channel_values._b4AppliedInputIds,
    ).toBeUndefined()
  } finally {
    await host?.close()
    await f.close()
  }
}, 30_000)

it("checks system privilege, text bytes and configured inbox bytes before acceptance", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit(body({ on_completion: "keep" }))
    let privileged = false
    const service = createInputService({
      ...f.authority,
      authorizeSystemInput: async () => privileged,
      limits: { entries: 128, bytes: 110, textBytes: 65536 },
      resolveTarget: async ({ run }) => ({
        adapter: agentBackendAdapter,
        agentId: run.run.agent_id!,
        namespaceGeneration: run.run.run_id,
        systemInjection: privileged,
      }),
    })
    await expect(
      service.inject(f.request(), accepted.threadId, accepted.runId, params(undefined, "system")),
    ).rejects.toMatchObject({ code: "not_supported" })
    await expect(
      service.inject(
        f.request(),
        accepted.threadId,
        accepted.runId,
        params(undefined, "user", "é".repeat(32769)),
      ),
    ).rejects.toMatchObject({ code: "body_too_large" })
    privileged = true
    expect(
      (
        await service.inject(
          f.request(),
          accepted.threadId,
          accepted.runId,
          params(undefined, "system", "privileged"),
        )
      ).b4.receipt.disposition,
    ).toBe("accepted")
    await expect(
      service.inject(
        f.request(),
        accepted.threadId,
        accepted.runId,
        params(undefined, "user", "extra"),
      ),
    ).rejects.toMatchObject({ code: "capacity_exceeded" })
    expect(
      (await f.snapshot(accepted.threadId)).inbox.filter((row) => row.kind === "inject"),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 30_000)

it("requires explicit current system privilege and rolls back a privilege flip before acceptance", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const resolveTarget: Parameters<typeof createInputService>[0]["resolveTarget"] = async ({
      run,
    }) => ({
      adapter: agentBackendAdapter,
      agentId: run.run.agent_id!,
      namespaceGeneration: run.run.run_id,
      systemInjection: true,
    })
    const absent = createInputService({ ...f.authority, resolveTarget })
    await expect(
      absent.inject(f.request(), accepted.threadId, accepted.runId, params(undefined, "system")),
    ).rejects.toMatchObject({ code: "not_supported" })
    const denied = createInputService({
      ...f.authority,
      resolveTarget,
      authorizeSystemInput: async () => false,
    })
    await expect(
      denied.inject(f.request(), accepted.threadId, accepted.runId, params(undefined, "system")),
    ).rejects.toMatchObject({ code: "permission_denied" })
    let checks = 0
    const flipped = createInputService({
      ...f.authority,
      resolveTarget,
      authorizeSystemInput: async () => ++checks === 1,
    })
    await expect(
      flipped.inject(f.request(), accepted.threadId, accepted.runId, params(undefined, "system")),
    ).rejects.toMatchObject({ code: "permission_denied" })
    expect(checks).toBe(2)
    expect(
      (await f.snapshot(accepted.threadId)).inbox.filter((row) => row.kind === "inject"),
    ).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)
