import {
  __resetApprovalGrantsForTests,
  configureApprovalGrants,
  wrapToolWithApproval,
} from "@b4run/core"
import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { createPermissionsStore } from "@b4run/permissions/node"
import { APPROVAL_GRANT_MINTER_KEY, agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, expect, it, vi } from "vitest"
import { z } from "zod"
import { gatePathOp } from "../../core/dist/capabilities/permission-gate.js"
import {
  createRuntimeCheckpointSaver,
  inheritRuntimeChildContinuation,
  runtimeNativePermissionBinding,
} from "../src/lib/runtime/checkpoint-saver.ts"
import {
  bindProtocolAgentExecution,
  bindProtocolChildGraph,
  buildGuardedSubagentResolver,
  rebindStoppedCheckpoint,
} from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import {
  childInputExecution,
  createActiveInputBoundary,
  createInputService,
} from "../src/lib/runtime/inputs.ts"
import { hash } from "../src/lib/runtime/operation-ledger.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"
import { rejectStoppedSourceFaults } from "./fixtures/protocol-source-faults.ts"

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  __resetApprovalGrantsForTests()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
it.each([false, true])(
  "restores an owned native child and retains completed child authority (stop accepted %s)",
  async (stopAccepted) => {
    __resetApprovalGrantsForTests()
    configureApprovalGrants("required")
    const f = await fixture(),
      counts = new Map<string, number>()
    const entered = deferred(),
      release = deferred(),
      consumed: string[][] = []
    let retainedChild:
      | { invoke(input: unknown, config: RunnableConfig): Promise<unknown>; config: RunnableConfig }
      | undefined
    let host: ReturnType<typeof createExecutionHost> | undefined,
      failure: unknown,
      effects = 0,
      prepared = 0,
      pendingBodies = 0
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "guarded-native-child"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const name = String(messages[0]?.content),
          count = (counts.get(name) ?? 0) + 1
        counts.set(name, count)
        if (name === "paused") consumed.push(messages.map((message) => String(message.content)))
        const message =
          name === "root" && count === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "root-inspect", name: "inspectRoot", args: {} }],
              })
            : name === "root" && count === 2
              ? new AIMessage({
                  content: "",
                  tool_calls: ["finished", "paused"].map((subagent, index) => ({
                    id: `delegate-${index}`,
                    name: "task",
                    args: { subagent, input: "review" },
                  })),
                })
              : name === "paused" && count === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [{ id: "child-inspect", name: "inspectChild", args: {} }],
                  })
                : name === "paused" && count === 2
                  ? new AIMessage({
                      content: "",
                      tool_calls: [{ id: "protected-child-call", name: "protect", args: {} }],
                    })
                  : new AIMessage(`${name} result`)
        return { generations: [{ text: "", message }] }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      const sourceInput = createInputService({
        ...f.authority,
        resolveTarget: async ({ run, namespaceBinding }) => ({
          adapter: agentBackendAdapter,
          agentId: namespaceBinding?.agentId ?? run.run.agent_id!,
          namespaceGeneration: namespaceBinding?.namespaceGeneration ?? run.run.run_id,
          systemInjection: false,
        }),
      })
      const sourceInject = async (namespace: readonly string[], content: string) =>
        sourceInput.inject(f.request(), accepted.threadId, accepted.runId, {
          namespace,
          message: { role: "user", content, b4: { v: 1, submissionId: crypto.randomUUID() } },
        })
      const rules =
        f.native.ruleStore() ??
        createPermissionsStore({ appRoot: f.directory, config: undefined, mode: "interactive" })
      const permissions = createPermissionService({
        ...f.authority,
        grants: "required",
        resolvePermissions: async () => rules,
      })
      const protectedTool = wrapToolWithApproval(
        {
          name: "protect",
          description: "Protected child.",
          async run() {
            pendingBodies++
            if (
              !(await gatePathOp(rules, "writeFile", "/outside/child-result.txt", "/workspace"))
                .allowed
            )
              return "denied"
            effects++
            entered.resolve()
            await release.promise
            return "child effect"
          },
        },
        rules,
      )
      host = createExecutionHost({
        ...f.authority,
        permissions,
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
            if (run.metadata.previousRunId) {
              const before = await store.snapshot(),
                selected = before.pending.find(
                  (row) =>
                    row.ownerRunId === run.metadata.previousRunId && row.disposition === "answered",
                )!.proposal!.nativeBinding!
              const original = before.checkpoints.find(
                (row) => row.state.checkpoint.checkpoint_id === selected.checkpointId,
              )!
              const payload = original.payload as { checkpoint: [string, number[]] }
              const checkpoint = (await saver.serde.loadsTyped(
                payload.checkpoint[0],
                Uint8Array.from(payload.checkpoint[1]),
              )) as { channel_values: Record<string, unknown> }
              const ids = checkpoint.channel_values._b4AppliedInputIds as string[]
              expect(ids).toHaveLength(1)
              const rootId = before.inbox.find(
                (row) => row.kind === "inject" && !row.namespace.length && row.status === "applied",
              )!.entryId
              const countsBefore = [...counts]
              for (const invalid of [
                [crypto.randomUUID()],
                [...ids, crypto.randomUUID()],
                [rootId],
              ]) {
                const [kind, bytes] = await saver.serde.dumpsTyped({
                  ...checkpoint,
                  channel_values: { ...checkpoint.channel_values, _b4AppliedInputIds: invalid },
                })
                try {
                  await store.transaction((tx) =>
                    tx.checkpoints.put({
                      ...original,
                      payload: { ...(original.payload as object), checkpoint: [kind, [...bytes]] },
                    }),
                  )
                  await expect(
                    permissions.prepareNativeContinuation(store, saver, run.run.run_id),
                  ).rejects.toMatchObject({ code: "approval_changed" })
                  expect([...counts]).toEqual(countsBefore)
                  expect(effects).toBe(0)
                } finally {
                  await store.transaction((tx) => tx.checkpoints.put(original))
                }
              }
            }
            const continuation = run.metadata.previousRunId
              ? await permissions.prepareNativeContinuation(store, saver, run.run.run_id)
              : undefined
            const invocation = permissions.createNativeParkMinter(store, saver, run.run.run_id)
            type ChildGraph = {
              invoke(input: unknown, config: RunnableConfig): Promise<unknown>
              getState(config: RunnableConfig): Promise<{
                config: { configurable: { checkpoint_id: string } }
                tasks: {
                  id: string
                  interrupts: { id: string; value: { interruptId: string; grant?: string } }[]
                }[]
              }>
            }
            let childState: Awaited<ReturnType<ChildGraph["getState"]>> | undefined,
              childNamespace: string[] | undefined
            const resolver = buildGuardedSubagentResolver({
              parentRouteId: "/chat",
              interruptCapable: true,
              cacheChildGraphs: false,
              permissions: rules,
              registry: [
                {
                  name: "finished",
                  routeId: "/other",
                  description: "Completed output.",
                  source: "explicit",
                  rule: { action: "allow" },
                },
                {
                  name: "paused",
                  routeId: "/changed",
                  description: "Paused action.",
                  source: "explicit",
                  rule: { action: "allow" },
                },
              ],
              async prepareChild(entry, context) {
                prepared++
                if (run.metadata.previousRunId) {
                  await store.transaction(async (tx) => {
                    const namespace = String(
                      context.nativeConfig.configurable?.checkpoint_ns,
                    ).split("|")
                    const prior = (await tx.nativeNamespaces.list()).find(
                      (row) =>
                        row.runId === run.metadata.previousRunId &&
                        JSON.stringify(row.namespace) === JSON.stringify(namespace),
                    )!
                    const receipt = (await tx.receipts.list()).find(
                      (row) =>
                        row.receipt.runId === run.run.run_id &&
                        row.operation?.method === "input.respond",
                    )!
                    const source = {
                      v: 1 as const,
                      kind: "permission_continuation" as const,
                      threadId: tx.scope.threadId,
                      generation: tx.scope.generation,
                      runId: prior.runId,
                      aliasId: prior.aliasId,
                      namespaceGeneration: prior.namespaceGeneration,
                      checkpointId: prior.checkpointId,
                      parentCheckpointId: prior.parentCheckpointId,
                      receiptId: receipt.receiptId,
                    }
                    const record = {
                      ...prior,
                      runId: run.run.run_id,
                      aliasId: `namespace:${hash([tx.scope.threadId, tx.scope.generation, run.run.run_id, namespace])}`,
                      namespaceGeneration: crypto.randomUUID(),
                      source,
                      status: "running" as const,
                      revision: (await tx.thread.get())!.revision + 1,
                    }
                    for (const invalid of [
                      { ...record, agentId: "/other#agent" },
                      {
                        ...record,
                        source: { ...source, namespaceGeneration: crypto.randomUUID() },
                      },
                      { ...record, source: { ...source, checkpointId: prior.parentCheckpointId } },
                      { ...record, source: { ...source, parentCheckpointId: prior.checkpointId } },
                      { ...record, source: { ...source, receiptId: "0".repeat(64) } },
                      { ...record, namespaceGeneration: prior.namespaceGeneration },
                    ])
                      await expect(tx.nativeNamespaces.put(invalid)).rejects.toMatchObject({
                        code: "scope_mismatch",
                      })
                    const { source: _source, ...ordinary } = record
                    await expect(tx.nativeNamespaces.put(ordinary)).rejects.toMatchObject({
                      code: "scope_mismatch",
                    })
                    expect(await tx.nativeNamespaces.get(record.aliasId)).toBeUndefined()
                  })
                }
                let child: Awaited<ReturnType<typeof childInputExecution>>
                try {
                  child = await childInputExecution(
                    saver,
                    `${entry.routeId}#agent`,
                    context.nativeConfig,
                  )
                } catch (error) {
                  failure = error
                  throw error
                }
                if (!child) throw new Error("Missing owned child saver")
                if (run.metadata.previousRunId) {
                  const before = await store.transaction((tx) => tx.nativeNamespaces.list())
                  await childInputExecution(saver, `${entry.routeId}#agent`, context.nativeConfig)
                  expect(await store.transaction((tx) => tx.nativeNamespaces.list())).toEqual(
                    before,
                  )
                  const record = before.find((row) => row.runId === run.run.run_id)!
                  expect(record.namespaceGeneration).not.toBe(record.source!.namespaceGeneration)
                  const stale = createRuntimeCheckpointSaver({
                    store,
                    runId: run.run.run_id,
                    namespace: record.namespace,
                    binding: {
                      agentId: record.agentId,
                      namespaceGeneration: record.source!.namespaceGeneration,
                      parentCheckpointId: record.parentCheckpointId,
                      source: record.source!,
                      status: "running",
                    },
                  })
                  await inheritRuntimeChildContinuation(saver, stale)
                  await expect(
                    stale.putWrites(
                      {
                        configurable: {
                          thread_id: accepted.threadId,
                          checkpoint_ns: record.namespace.join("|"),
                          checkpoint_id: record.source!.checkpointId,
                        },
                      },
                      [],
                      "stale-task",
                    ),
                  ).rejects.toMatchObject({ code: "stale_generation" })
                }
                const graph = (await materializeAgentGraph({
                  descriptor: agent({ model: "gpt-5-mini", systemPrompt: entry.name }),
                  checkpointer: child.checkpointer,
                  activeInput: child.activeInput,
                  tools:
                    entry.name === "paused"
                      ? [
                          protectedTool,
                          {
                            name: "inspectChild",
                            description: "Inject source child input.",
                            async run() {
                              await sourceInject(
                                String(context.nativeConfig.configurable?.checkpoint_ns).split("|"),
                                "source child steering",
                              )
                              return "observed"
                            },
                          },
                        ]
                      : [],
                })) as ChildGraph
                const recorded = {
                  async invoke(input: unknown, config: RunnableConfig) {
                    try {
                      const namespace = String(config.configurable?.checkpoint_ns).split("|")
                      const selected = await store.transaction(async (tx) =>
                        (await tx.nativeNamespaces.list()).find(
                          (row) =>
                            row.runId === run.run.run_id &&
                            JSON.stringify(row.namespace) === JSON.stringify(namespace),
                        ),
                      )
                      expect(Object.hasOwn(config.configurable!, "checkpoint_id")).toBe(false)
                      expect(
                        Object.hasOwn(config.configurable!.checkpoint_map, namespace.join("|")),
                      ).toBe(false)
                      const implicit = await child.checkpointer.getTuple(config)
                      expect(implicit?.checkpoint.id).toBe(selected?.checkpointId)
                      expect(
                        Object.hasOwn(config.configurable!.checkpoint_map, "unrelated:namespace"),
                      ).toBe(false)
                    } catch (error) {
                      failure = error
                      throw error
                    }
                    try {
                      return await graph.invoke(input, config)
                    } finally {
                      if (entry.name === "paused") {
                        const { checkpoint_id: _selected, ...configurable } = config.configurable!
                        childState = await graph.getState({ ...config, configurable })
                        childNamespace = String(config.configurable?.checkpoint_ns).split("|")
                      }
                    }
                  },
                }
                const owned = bindProtocolChildGraph(recorded, child)
                return {
                  routeId: entry.routeId,
                  routeKey: `${entry.routeId}#agent`,
                  graph: {
                    async invoke(input: unknown, config: RunnableConfig) {
                      const namespace = String(config.configurable?.checkpoint_ns).split("|"),
                        snapshot = await store.snapshot()
                      const modelCount = counts.get(entry.name) ?? 0
                      const bindingBefore = (
                        await store.transaction((tx) => tx.nativeNamespaces.list())
                      ).filter(
                        (row) =>
                          row.runId === run.run.run_id &&
                          JSON.stringify(row.namespace) === JSON.stringify(namespace),
                      )
                      for (const [configurable, code] of [
                        [{ ...config.configurable, thread_id: crypto.randomUUID() }, "not_found"],
                        [
                          { ...config.configurable, checkpoint_ns: `wrong:${crypto.randomUUID()}` },
                          "not_found",
                        ],
                        [
                          {
                            ...config.configurable,
                            checkpoint_map: {
                              ...config.configurable?.checkpoint_map,
                              [namespace.slice(0, -1).join("|")]: crypto.randomUUID(),
                            },
                          },
                          "stale_generation",
                        ],
                      ] as const)
                        await expect(
                          owned.invoke(input, { ...config, configurable }),
                        ).rejects.toMatchObject({ code })
                      expect(counts.get(entry.name) ?? 0).toBe(modelCount)
                      expect(
                        (await store.transaction((tx) => tx.nativeNamespaces.list())).filter(
                          (row) =>
                            row.runId === run.run.run_id &&
                            JSON.stringify(row.namespace) === JSON.stringify(namespace),
                        ),
                      ).toEqual(bindingBefore)
                      retainedChild ??= { invoke: owned.invoke.bind(owned), config }
                      const selected = (
                        await store.transaction((tx) => tx.nativeNamespaces.list())
                      ).find(
                        (row) =>
                          row.runId === run.run.run_id &&
                          JSON.stringify(row.namespace) === JSON.stringify(namespace),
                      )
                      const historical = snapshot.checkpoints.find(
                        (row) =>
                          JSON.stringify(row.namespace) === JSON.stringify(namespace) &&
                          row.state.checkpoint.checkpoint_id !== selected?.checkpointId,
                      )
                      const inherited =
                        historical?.state.checkpoint.checkpoint_id ??
                        context.nativeConfig.configurable!.checkpoint_map[
                          namespace.slice(0, -1).join("|")
                        ]
                      return owned.invoke(input, {
                        ...config,
                        configurable: {
                          ...config.configurable,
                          checkpoint_id: inherited,
                          checkpoint_map: {
                            ...config.configurable?.checkpoint_map,
                            [namespace.join("|")]: inherited,
                            "unrelated:namespace": crypto.randomUUID(),
                          },
                        },
                      })
                    },
                  },
                }
              },
            })
            const graph = (await materializeAgentGraph({
              descriptor: agent({ model: "gpt-5-mini", systemPrompt: "root" }),
              checkpointer: saver,
              activeInput: boundary.activeInput,
              subagentResolver: resolver,
              tools: [
                {
                  name: "task",
                  description: "Delegate.",
                  schema: z.object({ subagent: z.string(), input: z.string() }),
                  async run() {
                    throw new Error("Task placeholder executed")
                  },
                },
                {
                  name: "inspectRoot",
                  description: "Inject root source input.",
                  async run() {
                    await sourceInject([], "source root steering")
                    return "observed root"
                  },
                },
              ],
            })) as ChildGraph
            const config = {
              configurable: {
                thread_id: accepted.threadId,
                checkpoint_ns: "",
                ...continuation?.configurable,
                ...invocation.configurable,
                ...(invocation.minter ? { [APPROVAL_GRANT_MINTER_KEY]: invocation.minter } : {}),
              },
              signal,
              durability: "sync",
            }
            try {
              await bindProtocolAgentExecution({
                store,
                runId: run.run.run_id,
                checkpointer: saver,
                entry: graph,
                config,
              })
              const output = await agentBackendAdapter.execute(
                graph,
                continuation?.input ?? run.run.input,
                { signal },
              )
              if (failure) throw failure
              if (!childState && (run.run.run_id === accepted.runId || run.metadata.previousRunId))
                throw new Error(`No guarded child result: ${JSON.stringify(output)}`)
              const task = childState?.tasks.find((row) => row.interrupts.length),
                parked = task?.interrupts[0]
              if (task && parked && childState && childNamespace) {
                const nativeBinding = await runtimeNativePermissionBinding(
                  saver,
                  childState.config.configurable.checkpoint_id,
                  task.id,
                  parked.id,
                )
                const { interruptId, grant: _grant, ...request } = parked.value
                const detail = request as {
                  kind?: string
                  detail?: { operation: string; path: string }
                }
                await store.transaction((tx) =>
                  parkPermissions(
                    tx,
                    run.run.run_id,
                    [
                      {
                        namespace: childNamespace!,
                        agentId: "/changed#agent",
                        interruptId,
                        request,
                        protectedProposal:
                          detail.kind === "path"
                            ? { operation: detail.detail!.operation, path: detail.detail!.path }
                            : {},
                        nativeBinding,
                      },
                    ],
                    "required",
                    saver,
                  ),
                )
              }
            } finally {
              invocation.dispose()
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
      const parked = await f.snapshot(accepted.threadId),
        pending = parked.pending[0]!
      const parkedCounts = [...counts]
      await expect(retainedChild!.invoke({}, retainedChild!.config)).rejects.toMatchObject({
        code: "stale_fence",
      })
      expect([...counts]).toEqual(parkedCounts)
      expect(pending.proposal?.agentId).toBe("/changed#agent")
      expect(counts.get("finished")).toBe(1)
      expect(effects).toBe(0)
      const command = {
        id: 1,
        method: "input.respond",
        params: {
          namespace: pending.namespace,
          interruptId: pending.input.data.interruptId,
          response: { decision: "once", grant: pending.input.data.b4.grant },
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        },
      }
      const backend = runtimeStorageRegistration(f.storage),
        open = backend.openThread.bind(backend)
      let snapshots = 0
      Object.assign(backend, {
        async openThread(...args: Parameters<typeof open>) {
          const store = await open(...args)
          if (store) {
            const snapshot = store.snapshot.bind(store)
            Object.assign(store, {
              async snapshot() {
                snapshots++
                return snapshot()
              },
            })
          }
          return store
        },
      })
      f.removeAgent("/other#agent")
      try {
        await expect(
          permissions.respond(f.request(), accepted.threadId, accepted.runId, command),
        ).rejects.toMatchObject({ code: "not_found" })
        expect(snapshots).toBe(0)
        expect(prepared).toBe(2)
      } finally {
        f.restoreAgent("/other#agent")
        Object.assign(backend, { openThread: open })
      }
      let resumed = await permissions.respond(
        f.request(),
        accepted.threadId,
        accepted.runId,
        command,
      )
      const receipt = (await f.snapshot(accepted.threadId)).receipts.find(
        (row) => row.receipt.runId === resumed.runId,
      )!
      expect(receipt.operation?.resolved.permissionAgents).toEqual([
        "/changed#agent",
        "/other#agent",
      ])
      await host.tick()
      await host.idle()
      if (failure) throw failure
      expect(effects).toBe(0)
      expect(pendingBodies).toBe(1)
      const later = (await f.snapshot(accepted.threadId)).pending.find(
        (row) => row.disposition === "pending",
      )!
      expect(later.proposal?.nativeBinding?.interruptIndex).toBe(1)
      const secondCommand = {
        id: 2,
        method: "input.respond",
        params: {
          namespace: later.namespace,
          interruptId: later.input.data.interruptId,
          response: { decision: "once", grant: later.input.data.b4.grant },
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        },
      }
      resumed = await permissions.respond(
        f.request(),
        accepted.threadId,
        resumed.runId,
        secondCommand,
      )
      if (stopAccepted) {
        await host.cancel(f.request(), accepted.threadId, resumed.runId, { wait: true })
        const store = await f.store(accepted.threadId),
          before = await store.snapshot(),
          checkpoint = before.thread!.headCheckpointId!
        const saver = createRuntimeCheckpointSaver({ store, runId: resumed.runId, namespace: [] })
        const graph = await materializeAgentGraph({
          descriptor: agent({ model: "gpt-5-mini", systemPrompt: "root" }),
          checkpointer: saver,
          activeInput: createActiveInputBoundary({
            store,
            runId: resumed.runId,
            namespace: [],
            namespaceGeneration: resumed.runId,
          }).activeInput,
        })
        const rebind = {
          ...f.authority,
          request: f.request(),
          store,
          runId: resumed.runId,
          checkpointer: saver,
          adapter: agentBackendAdapter,
          entry: graph,
          config: {
            configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            durability: "sync",
          },
        }
        const fault = new Error("child-source-rebind-rollback")
        await expect(
          rebindStoppedCheckpoint({
            ...rebind,
            failpoint() {
              throw fault
            },
          }),
        ).rejects.toBe(fault)
        expect(await store.snapshot()).toEqual(before)
        await rebindStoppedCheckpoint(rebind)
        const rebound = await store.snapshot(),
          safe = rebound.checkpoints.find(
            (row) => row.state.checkpoint.checkpoint_id === rebound.thread?.headCheckpointId,
          )!
        expect(
          (
            safe.payload as {
              reboundFrom: {
                checkpointId: string
                checkpointOwnerRunId: string
                stoppedSource: { path: unknown[] }
              }
            }
          ).reboundFrom,
        ).toMatchObject({
          checkpointId: checkpoint,
          checkpointOwnerRunId: accepted.runId,
          stoppedSource: { path: [{ runId: resumed.runId }, { runId: later.ownerRunId }] },
        })
        expect(
          (await store.transaction((tx) => tx.nativeNamespaces.list())).every(
            (row) => row.status === "retired" || row.status === "closed",
          ),
        ).toBe(true)
        await rejectStoppedSourceFaults(f, accepted.threadId, store)
        expect(effects).toBe(0)
        expect(counts.get("paused")).toBe(2)
        expect(counts.get("finished")).toBe(1)
        const token = crypto.randomUUID(),
          fresh = await f.admit(
            body({
              thread_id: accepted.threadId,
              metadata: { b4: { v: 1, submissionId: token } },
              on_completion: "keep",
            }),
          )
        await host.tick()
        await host.idle()
        if (failure) throw failure
        expect(effects).toBe(0)
        expect(counts.get("paused")).toBe(2)
        expect(counts.get("root")).toBe(3)
        expect(counts.get("finished")).toBe(1)
        expect(
          (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === fresh.runId)
            ?.run.status,
        ).toBe("success")
        for (const source of before.runs)
          await f.native.removeLiveRunPayload(
            accepted.threadId,
            before.scope.generation,
            source.run.run_id,
          )
        expect(await f.lookup(token)).toHaveLength(1)
        f.removeAgent("/other#agent")
        expect(await f.lookup(token)).toEqual([])
        await f.native.corruptProtectedSourceDigest(
          accepted.threadId,
          before.scope.generation,
          fresh.runId,
        )
        expect(await f.lookup(token)).toEqual([])
        f.restoreAgent("/other#agent")
        await expect(f.lookup(token)).rejects.toMatchObject({ code: "storage_unavailable" })
        return
      }
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw failure ?? new Error("Child completed before the controlled effect barrier")
        }),
      ])
      const currentStore = await f.store(accepted.threadId),
        restoredBinding = (await currentStore.transaction((tx) => tx.nativeNamespaces.list())).find(
          (row) => row.runId === resumed.runId,
        )!
      const injection = (namespaceGeneration: string) =>
        createInputService({
          ...f.authority,
          resolveTarget: async () => ({
            adapter: agentBackendAdapter,
            agentId: restoredBinding.agentId,
            namespaceGeneration,
            systemInjection: false,
          }),
        })
      const injected = {
        namespace: restoredBinding.namespace,
        message: {
          role: "user",
          content: "steer restored child",
          b4: { v: 1, submissionId: crypto.randomUUID() },
        },
      }
      await expect(
        injection(restoredBinding.source!.namespaceGeneration).inject(
          f.request(),
          accepted.threadId,
          resumed.runId,
          injected,
        ),
      ).rejects.toMatchObject({ code: "stale_generation" })
      await injection(restoredBinding.namespaceGeneration).inject(
        f.request(),
        accepted.threadId,
        resumed.runId,
        injected,
      )
      release.resolve()
      await host.idle()
      if (failure) throw failure
      expect(effects).toBe(1)
      expect(counts.get("finished")).toBe(1)
      expect(counts.get("paused")).toBe(3)
      expect(counts.get("root")).toBe(3)
      expect(pendingBodies).toBe(2)
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === resumed.runId)
          ?.run.status,
      ).toBe("success")
      expect(consumed[2]).toEqual(
        expect.arrayContaining(["source child steering", "steer restored child"]),
      )
      f.removeAgent("/other#agent")
      expect(await f.lookup(command.params.metadata.b4.submissionId)).toEqual([])
      await expect(
        host.cancel(f.request(), accepted.threadId, resumed.runId, {}),
      ).rejects.toMatchObject({ code: "not_found" })
      await expect(
        permissions.respond(f.request(), accepted.threadId, accepted.runId, command),
      ).rejects.toMatchObject({ code: "not_found" })
    } finally {
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
