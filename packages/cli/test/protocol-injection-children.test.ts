import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent, type BackendAdapter } from "@b4run/sdk"
import { protectedSourceDigest } from "@b4run/sdk/internal/runtime-identity"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { interrupt } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import { z } from "zod"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import {
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
import { parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture, token } from "./fixtures/protocol-admission.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each([
  { inject: true, completion: "keep", stopSource: false },
  { inject: false, completion: "keep", stopSource: false },
  { inject: false, completion: "delete", stopSource: false },
  { inject: true, completion: "delete", stopSource: false },
  { inject: false, completion: "keep", stopSource: true },
  { inject: true, completion: "keep", stopSource: true },
] as const)(
  "keeps complete child authority and namespace ownership ($inject/$completion/stop:$stopSource)",
  async ({ inject, completion, stopSource }) => {
    const f = await fixture()
    const release = deferred(),
      ready = [deferred(), deferred()]
    let host: ReturnType<typeof createExecutionHost> | undefined
    const seen = new Map<string, string[][]>(),
      namespaces = new Map<string, readonly string[]>()
    let failure: unknown,
      protectedActions = 0
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "controlled-native-children"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const name = String(messages[0]?.content),
          history = seen.get(name) ?? []
        history.push(messages.map((message) => String(message.content)))
        seen.set(name, history)
        const message =
          name === "root" && history.length === 1
            ? new AIMessage({
                content: "",
                tool_calls: ["first", "second"].map((subagent, index) => ({
                  id: `child-${index}`,
                  name: "task",
                  args: { subagent, input: "review" },
                })),
              })
            : name === "root" && stopSource && history.length === 2
              ? new AIMessage({
                  content: "",
                  tool_calls: [{ id: "source-protected", name: "protect", args: {} }],
                })
              : name !== "root" && history.length === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [{ id: `${name}-inspect`, name: "inspect", args: {} }],
                  })
                : new AIMessage(`${name} finished`)
        return { generations: [{ text: "", message }] }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: completion }))
      let resolutions = 0
      const service = createInputService({
        ...f.authority,
        resolveTarget: async ({ run, namespace, snapshot }) => {
          resolutions++
          if (!namespace.length)
            return {
              adapter: agentBackendAdapter,
              agentId: run.run.agent_id!,
              namespaceGeneration: run.run.run_id,
              systemInjection: false,
            }
          const row = snapshot.checkpoints.find(
            (row) =>
              JSON.stringify(row.namespace) === JSON.stringify(namespace) &&
              (row.payload as { binding?: unknown }).binding,
          )
          if (!row) throw new Error("Missing actual child namespace checkpoint")
          const binding = (
            row.payload as { binding: { agentId: string; namespaceGeneration: string } }
          ).binding
          return { adapter: agentBackendAdapter, ...binding, systemInjection: false }
        },
      })
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
          const resolver = buildGuardedSubagentResolver({
            parentRouteId: "/chat",
            interruptCapable: true,
            cacheChildGraphs: false,
            registry: [
              {
                name: "first",
                routeId: "/changed",
                description: "First.",
                source: "explicit",
                rule: { action: "allow" },
              },
              {
                name: "second",
                routeId: "/other",
                description: "Second.",
                source: "explicit",
                rule: { action: "allow" },
              },
            ],
            async prepareChild(entry, context) {
              let child: Awaited<ReturnType<typeof childInputExecution>>
              try {
                child = await childInputExecution(
                  checkpointer,
                  `${entry.routeId}#agent`,
                  context.nativeConfig,
                )
              } catch (error) {
                failure = error
                throw error
              }
              if (!child) throw new Error("Missing actual child binding")
              const index = entry.name === "first" ? 0 : 1
              const native = context.nativeConfig.configurable?.checkpoint_ns
              expect(typeof native).toBe("string")
              namespaces.set(entry.name, String(native).split("|"))
              const graph = (await materializeAgentGraph({
                descriptor: agent({ model: "gpt-5-mini", systemPrompt: entry.name }),
                checkpointer: child.checkpointer,
                activeInput: child.activeInput,
                tools: [
                  {
                    name: "inspect",
                    description: "Inspect.",
                    run: async () => {
                      ready[index]!.resolve()
                      await release.promise
                      return "observed"
                    },
                  },
                ],
              })) as { invoke(input: unknown, config: RunnableConfig): Promise<unknown> }
              const bound = bindProtocolChildGraph(graph, child)
              return {
                routeId: entry.routeId,
                routeKey: `${entry.routeId}#agent`,
                graph: {
                  async invoke(input, config) {
                    try {
                      return await bound.invoke(input, config)
                    } catch (error) {
                      failure ??= error
                      throw error
                    }
                  },
                },
              }
            },
          })
          const graph = (await materializeAgentGraph({
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "root" }),
            checkpointer,
            activeInput: boundary.activeInput,
            subagentResolver: resolver,
            tools: [
              {
                name: "task",
                description: "Delegate.",
                schema: z.object({ subagent: z.string(), input: z.string() }),
                run: async () => {
                  throw new Error("Task placeholder executed")
                },
              },
              {
                name: "protect",
                description: "Protected source action.",
                run: async () => {
                  interrupt("permission required")
                  protectedActions++
                  return "protected effect"
                },
              },
            ],
          })) as {
            invoke(input: unknown, config: RunnableConfig): Promise<unknown>
            getState(config: RunnableConfig): Promise<{
              config: { configurable: { checkpoint_id: string } }
              tasks: { id: string; interrupts: { id: string }[] }[]
            }>
          }
          const config = {
            configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            signal,
            durability: "sync",
          }
          try {
            await graph.invoke(run.run.input, config)
            if (stopSource && run.run.run_id === accepted.runId) {
              const state = await graph.getState(config),
                task = state.tasks.find((row) => row.interrupts.length)
              if (!task?.interrupts[0]) throw new Error("Missing actual stopped-source task")
              await store.transaction((tx) =>
                parkPermissions(
                  tx,
                  run.run.run_id,
                  [
                    {
                      namespace: [],
                      interruptId: task.interrupts[0]!.id,
                      request: {
                        kind: "tool",
                        detail: { toolName: "protect", suggestedPattern: "protect" },
                      },
                      protectedProposal: {
                        tool: "protect",
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
          } catch (error) {
            failure = error
            throw error
          }
          return {}
        },
      })
      await host.tick()
      await Promise.race([
        Promise.all(ready.map((entry) => entry.promise)),
        host.idle().then(() => {
          throw (
            failure ??
            new Error(`Root finished before both native children: ${JSON.stringify([...seen])}`)
          )
        }),
      ])
      const paused = await f.snapshot(accepted.threadId),
        generation = paused.scope.generation
      expect(
        paused.checkpoints.find(
          (row) => row.state.checkpoint.checkpoint_id === paused.thread?.headCheckpointId,
        )?.namespace,
      ).toEqual([])
      const owned = await f.store(accepted.threadId)
      const proofs = await owned.transaction((tx) => tx.nativeNamespaces.list())
      expect(proofs).toHaveLength(2)
      const proof = proofs[0]!
      await expect(
        owned.transaction((tx) =>
          tx.nativeNamespaces.put({
            ...proof,
            revision: proof.revision + 1,
            agentId: "/forged#agent",
          }),
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      await expect(
        owned.transaction((tx) =>
          tx.nativeNamespaces.put({
            ...proof,
            revision: proof.revision + 1,
            checkpointId: paused.thread!.headCheckpointId!,
          }),
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      expect(await owned.transaction((tx) => tx.nativeNamespaces.list())).toEqual(proofs)
      const backend = runtimeStorageRegistration(f.storage),
        originalOpen = backend.openThread
      let fullSnapshots = 0
      Object.assign(backend, {
        async openThread(...args: Parameters<typeof originalOpen>) {
          const store = await originalOpen(...args)
          if (store) {
            const snapshot = store.snapshot.bind(store)
            Object.assign(store, {
              async snapshot() {
                fullSnapshots++
                return snapshot()
              },
            })
          }
          return store
        },
      })
      f.removeAgent("/changed#agent")
      try {
        await expect(
          service.inject(f.request(), accepted.threadId, accepted.runId, {
            namespace: namespaces.get("first"),
            message: {
              role: "user",
              content: "never prepared",
              b4: { v: 1, submissionId: crypto.randomUUID() },
            },
          }),
        ).rejects.toMatchObject({ code: "not_found" })
        expect(fullSnapshots).toBe(0)
        expect(resolutions).toBe(0)
      } finally {
        f.restoreAgent("/changed#agent")
        Object.assign(backend, { openThread: originalOpen })
      }
      const tokens = [crypto.randomUUID(), crypto.randomUUID()]
      for (const [index, name] of (inject ? ["first", "second"] : []).entries()) {
        const result = await service.inject(f.request(), accepted.threadId, accepted.runId, {
          namespace: namespaces.get(name),
          message: {
            role: "user",
            content: `steer-${name}`,
            b4: { v: 1, submissionId: tokens[index] },
          },
        })
        expect(result.runId).toBe(accepted.runId)
      }
      release.resolve()
      await host.idle()
      expect(failure).toBeUndefined()
      expect(seen.get("first")?.[1]?.filter((text) => text.startsWith("steer"))).toEqual(
        inject ? ["steer-first"] : [],
      )
      expect(seen.get("second")?.[1]?.filter((text) => text.startsWith("steer"))).toEqual(
        inject ? ["steer-second"] : [],
      )
      expect((await f.lookup())[0]?.run_id).toBe(accepted.runId)
      if (inject)
        for (const token of tokens)
          expect((await f.lookup(token))[0]?.metadata.b4).toMatchObject({
            lookup: { receipt: { disposition: "applied" } },
          })
      if (completion === "delete") {
        await f.native.removeRetainedRun(accepted.threadId, generation, accepted.runId)
        await expect(f.lookup()).rejects.toMatchObject({ code: "submission_target_gone" })
      } else {
        const current = await f.snapshot(accepted.threadId)
        expect(current.runs).toHaveLength(1)
        expect(
          current.thread?.thread.messages?.some((message) =>
            String(message.content).startsWith("steer-"),
          ),
        ).toBe(false)
        expect(
          (
            await (await f.store(accepted.threadId)).transaction((tx) => tx.nativeNamespaces.list())
          ).every((row) => row.status === "closed"),
        ).toBe(true)
        await expect(
          service.inject(f.request(), accepted.threadId, accepted.runId, {
            namespace: namespaces.get("first"),
            message: {
              role: "user",
              content: "finished child",
              b4: { v: 1, submissionId: crypto.randomUUID() },
            },
          }),
        ).rejects.toMatchObject({ code: "stale_generation" })
      }
      let freshToken: string | undefined, freshRunId: string | undefined
      if (completion === "keep") {
        if (stopSource) {
          await host.cancel(f.request(), accepted.threadId, accepted.runId, {})
          const store = await f.store(accepted.threadId),
            checkpointer = createRuntimeCheckpointSaver({
              store,
              runId: accepted.runId,
              namespace: [],
            })
          const boundary = createActiveInputBoundary({
            store,
            runId: accepted.runId,
            namespace: [],
            namespaceGeneration: accepted.runId,
          })
          const graph = await materializeAgentGraph({
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "root" }),
            checkpointer,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "protect",
                description: "Protected source action.",
                run: async () => {
                  protectedActions++
                  return "must never run"
                },
              },
            ],
          })
          const beforeRebind = await store.snapshot()
          f.removeAgent("/changed#agent")
          await expect(
            rebindStoppedCheckpoint({
              ...f.authority,
              request: f.request(),
              store,
              runId: accepted.runId,
              checkpointer,
              adapter: agentBackendAdapter,
              entry: graph,
              config: {
                configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
                durability: "sync",
              },
            }),
          ).rejects.toMatchObject({ code: "not_found" })
          expect(await store.snapshot()).toEqual(beforeRebind)
          f.restoreAgent("/changed#agent")
          await rebindStoppedCheckpoint({
            ...f.authority,
            request: f.request(),
            store,
            runId: accepted.runId,
            checkpointer,
            adapter: agentBackendAdapter,
            entry: graph,
            config: {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
              durability: "sync",
            },
          })
          expect(protectedActions).toBe(0)
        }
        freshToken = crypto.randomUUID()
        const fresh = await f.admit(
          body({
            thread_id: accepted.threadId,
            on_completion: "keep",
            metadata: { b4: { v: 1, submissionId: freshToken } },
          }),
        )
        freshRunId = fresh.runId
        await host.tick()
        await host.idle()
        expect(failure).toBeUndefined()
        expect(protectedActions).toBe(0)
        expect((await f.lookup(freshToken))[0]?.run_id).toBe(fresh.runId)
        const proofs = await (await f.store(accepted.threadId)).transaction((tx) =>
          tx.protectedSources.list(),
        )
        expect(proofs).toHaveLength(1)
        expect(proofs[0]).toMatchObject({
          runId: fresh.runId,
          sourceRunId: accepted.runId,
          agents: ["/changed#agent", "/chat#agent", "/other#agent"],
        })
        const forged = { ...proofs[0]!, agents: ["/chat#agent"] }
        await expect(
          (await f.store(accepted.threadId)).transaction((tx) =>
            tx.protectedSources.put({ ...forged, digest: protectedSourceDigest(forged) }),
          ),
        ).rejects.toMatchObject({ code: "scope_mismatch" })
        await f.native.removeLiveRunPayload(accepted.threadId, generation, accepted.runId)
        expect(protectedActions).toBe(0)
        expect((await f.lookup(freshToken))[0]?.run_id).toBe(fresh.runId)
      }
      f.removeAgent("/changed#agent")
      expect(await f.search({})).toEqual([])
      expect(await f.lookup(token)).toEqual([])
      if (freshToken && freshRunId) {
        expect(await f.lookup(freshToken)).toEqual([])
        const resolutions = f.resolutionCount()
        await expect(
          f.admit(
            body({
              thread_id: accepted.threadId,
              agent_id: "/other#agent",
              metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
              on_completion: "keep",
            }),
          ),
        ).rejects.toMatchObject({ code: "not_found" })
        expect(f.resolutionCount()).toBe(resolutions)
        await f.native.corruptProtectedSourceDigest(accepted.threadId, generation, freshRunId)
        expect(await f.lookup(freshToken)).toEqual([])
        f.restoreAgent("/changed#agent")
        await expect(f.lookup(freshToken)).rejects.toMatchObject({ code: "storage_unavailable" })
        f.removeAgent("/changed#agent")
      }
      if (inject) {
        expect(await f.lookup(tokens[1])).toEqual([])
        await expect(
          service.inject(f.request(), accepted.threadId, accepted.runId, {
            namespace: namespaces.get("second"),
            message: {
              role: "user",
              content: "steer-second",
              b4: { v: 1, submissionId: tokens[1] },
            },
          }),
        ).rejects.toMatchObject({ code: "not_found" })
      }
      await expect(
        host.cancel(f.request(), accepted.threadId, accepted.runId, {}),
      ).rejects.toMatchObject({ code: "not_found" })
    } finally {
      release.resolve()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
