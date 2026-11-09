import {
  __resetApprovalGrantsForTests,
  configureApprovalGrants,
  wrapToolWithApproval,
} from "@b4run/core"
import { materializeAgentGraph } from "@b4run/langchain"
import {
  agentBackendAdapter,
  bindRuntimeChildReplayReader,
} from "@b4run/langchain/internal/runtime"
import { createPermissionsStore } from "@b4run/permissions/node"
import { APPROVAL_GRANT_MINTER_KEY, agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { Command } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  createRuntimeCheckpointSaver,
  runtimeNativePermissionBinding,
} from "../src/lib/runtime/checkpoint-saver.ts"
import {
  bindProtocolAgentExecution,
  bindProtocolChildGraph,
  buildGuardedSubagentResolver,
} from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { childInputExecution, createActiveInputBoundary } from "../src/lib/runtime/inputs.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  __resetApprovalGrantsForTests()
})

type NativeGraph = {
  invoke(input: unknown, config: RunnableConfig): Promise<unknown>
  getState(config: RunnableConfig): Promise<{
    config: { configurable: { checkpoint_id: string } }
    tasks: { id: string; interrupts: { id: string; value: Record<string, unknown> }[] }[]
  }>
}
type Chunk = { readonly type: string; readonly data: unknown }
type ChildReader = Parameters<typeof bindRuntimeChildReplayReader>[1]
const { childReplayReader } = await vi.importActual<{
  childReplayReader(graph: object): ChildReader | undefined
}>("../../langchain/src/replay-checkpoint-reader.ts")

it.each(["execute", "stream", "reader-authority"] as const)(
  "canonical child %s grant resume executes the protected body and preserves replay badges",
  async (kind) => {
    const mode = kind === "stream" ? "stream" : "execute"
    __resetApprovalGrantsForTests()
    configureApprovalGrants("required")
    const f = await fixture()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      failure: unknown,
      calls = 0,
      attempts = 0,
      effects = 0,
      prepared = 0,
      tools = true
    let capturedReader: (() => Promise<unknown>) | undefined
    const sourceChunks: Chunk[] = [],
      resumedChunks: Chunk[] = []
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "canonical-child-replay"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        const root = String(messages[0]?.content) === "root"
        const message = tools
          ? new AIMessage({
              content: "",
              tool_calls: [
                root
                  ? {
                      id: "delegate-child",
                      name: "task",
                      args: { subagent: "paused", input: "review" },
                    }
                  : { id: "child-effect", name: "effect", args: {} },
              ],
            })
          : new AIMessage("done")
        return { generations: [{ text: "", message }] }
      }
      async *_streamResponseChunks(messages: BaseMessage[]) {
        const result = await this._generate(messages)
        const message = result.generations[0]?.message as AIMessage
        if (typeof message.content !== "string")
          throw new Error("Controlled child replay model must return string content")
        yield new ChatGenerationChunk({
          text: typeof message.content === "string" ? message.content : "",
          message: new AIMessageChunk({
            content: message.content,
            ...(message.tool_calls?.length
              ? {
                  tool_call_chunks: message.tool_calls.map((call, index) => ({
                    ...(call.id !== undefined ? { id: call.id } : {}),
                    name: call.name,
                    args: JSON.stringify(call.args),
                    index,
                  })),
                }
              : {}),
          }),
        })
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const initial = await f.admit(body({ on_completion: "keep" }))
      const rules =
        f.native.ruleStore() ??
        createPermissionsStore({ appRoot: f.directory, config: undefined, mode: "interactive" })
      const permissions = createPermissionService({
        ...f.authority,
        grants: "required",
        resolvePermissions: async () => rules,
      })
      const guarded = wrapToolWithApproval(
        {
          name: "effect",
          description: "Protected child effect.",
          async run() {
            effects++
            return "child finished"
          },
        },
        rules,
      )
      const protectedTool = {
        ...guarded,
        async run(...args: Parameters<typeof guarded.run>) {
          attempts++
          return guarded.run(...args)
        },
      }
      host = createExecutionHost({
        ...f.authority,
        permissions,
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
          const rootReads = vi.spyOn(saver, "getTuple")
          const continuation = run.metadata.previousRunId
            ? await permissions.prepareNativeContinuation(store, saver, run.run.run_id)
            : undefined
          if (continuation) expect(continuation.input).toBeInstanceOf(Command)
          const park = permissions.createNativeParkMinter(store, saver, run.run.run_id)
          const config = {
            configurable: {
              thread_id: initial.threadId,
              checkpoint_ns: "",
              ...continuation?.configurable,
              ...park.configurable,
              ...(park.minter ? { [APPROVAL_GRANT_MINTER_KEY]: park.minter } : {}),
            },
            signal: context.signal,
            durability: "sync",
          }
          let childState: Awaited<ReturnType<NativeGraph["getState"]>> | undefined,
            childNamespace: string[] | undefined
          const resolver = buildGuardedSubagentResolver({
            parentRouteId: "/chat",
            interruptCapable: true,
            cacheChildGraphs: false,
            permissions: rules,
            registry: [
              {
                name: "paused",
                routeId: "/changed",
                description: "Owned child.",
                source: "explicit",
                rule: { action: "allow" },
              },
            ],
            async prepareChild(entry, childContext) {
              prepared++
              const child = await childInputExecution(
                saver,
                `${entry.routeId}#agent`,
                childContext.nativeConfig,
              )
              if (!child) throw new Error("Missing actual owned child")
              const graph = (await materializeAgentGraph({
                descriptor: agent({ model: "gpt-5-mini", systemPrompt: "child" }),
                checkpointer: child.checkpointer,
                activeInput: child.activeInput,
                tools: [protectedTool],
              })) as NativeGraph
              const recorded = {
                async invoke(input: unknown, childConfig: RunnableConfig) {
                  try {
                    return await graph.invoke(input, childConfig)
                  } finally {
                    const { checkpoint_id: _selected, ...rest } = childConfig.configurable ?? {}
                    childState = await graph.getState({ ...childConfig, configurable: rest })
                    childNamespace = String(childConfig.configurable?.checkpoint_ns).split("|")
                  }
                },
              }
              const bound = bindProtocolChildGraph(recorded, child)
              if (kind === "reader-authority" && !continuation) {
                try {
                  const reader = childReplayReader(bound)!
                  const config = childContext.nativeConfig
                  const before = await store.snapshot()
                  const beforeCalls = { calls, attempts, effects, prepared }
                  expect(await reader(config)).toBeUndefined()
                  await expect(
                    reader({
                      ...config,
                      configurable: { ...config.configurable, checkpoint_id: crypto.randomUUID() },
                    }),
                  ).rejects.toMatchObject({ code: "stale_generation" })
                  await expect(
                    reader({
                      ...config,
                      configurable: {
                        ...config.configurable,
                        checkpoint_map: {
                          ...config.configurable?.checkpoint_map,
                          [String(config.configurable?.checkpoint_ns)]: crypto.randomUUID(),
                        },
                      },
                    }),
                  ).rejects.toMatchObject({ code: "stale_generation" })
                  expect(await store.snapshot()).toEqual(before)
                  expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
                } catch (error) {
                  failure = error
                  throw error
                }
              }
              if (kind === "reader-authority" && continuation) {
                try {
                  const reader = childReplayReader(bound)
                  if (!reader) throw new Error("Actual guarded child reader missing")
                  const before = await store.snapshot()
                  const beforeCalls = { calls, attempts, effects, prepared }
                  const config = childContext.nativeConfig
                  capturedReader = () => reader(config)
                  const childReads = vi.spyOn(child.checkpointer, "getTuple")
                  const readOwned = async (read: typeof reader, requested = config) => {
                    const rootsBefore = rootReads.mock.calls.length
                    const childrenBefore = childReads.mock.calls.length
                    const result = await read(requested)
                    expect(rootReads.mock.calls.length).toBe(rootsBefore)
                    expect(childReads.mock.calls.length).toBe(childrenBefore + 1)
                    const selected = childReads.mock.calls.at(-1)![0]
                    expect(selected.configurable?.thread_id).toBe(config.configurable?.thread_id)
                    expect(selected.configurable?.checkpoint_ns).toBe(
                      config.configurable?.checkpoint_ns,
                    )
                    expect(selected.configurable?.checkpoint_id).toBeUndefined()
                    return result
                  }
                  const tuple = await readOwned(reader)
                  expect(tuple?.checkpoint.id).toEqual(expect.any(String))
                  expect(await store.snapshot()).toEqual(before)
                  expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
                  // Same namespace and saver, distinct outer wrapper identities:
                  // every capability still performs its own authority validation.
                  const secondBound = bindProtocolChildGraph(recorded, child)
                  const secondReader = childReplayReader(secondBound)!
                  expect(secondBound).not.toBe(bound)
                  expect(secondReader).not.toBe(reader)
                  expect((await readOwned(secondReader))?.checkpoint.id).toBe(tuple?.checkpoint.id)
                  expect(() => bindRuntimeChildReplayReader(bound, secondReader)).toThrow(
                    expect.objectContaining({ code: "not_supported" }),
                  )
                  expect(childReplayReader(bound)).toBe(reader)
                  expect(await store.snapshot()).toEqual(before)
                  expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
                  const refuse = async (
                    label: string,
                    configurable: Record<string, unknown>,
                    code: string,
                    outcomes?: Record<string, string>,
                  ) => {
                    let observed = "resolved"
                    const rootsBefore = rootReads.mock.calls.length
                    const childrenBefore = childReads.mock.calls.length
                    try {
                      await reader({ ...config, configurable })
                    } catch (error) {
                      observed = (error as { code?: string }).code ?? "unknown"
                    }
                    expect(rootReads.mock.calls.length).toBe(rootsBefore)
                    expect(childReads.mock.calls.length).toBe(childrenBefore)
                    expect(await store.snapshot()).toEqual(before)
                    expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
                    if (outcomes) outcomes[label] = observed
                    else expect(observed, label).toBe(code)
                  }
                  await refuse(
                    "wrong thread after successful read",
                    { ...config.configurable, thread_id: crypto.randomUUID() },
                    "not_found",
                  )
                  await refuse(
                    "wrong namespace after successful read",
                    { ...config.configurable, checkpoint_ns: `sibling:${crypto.randomUUID()}` },
                    "not_found",
                  )
                  const namespace = String(config.configurable?.checkpoint_ns)
                  const map = config.configurable?.checkpoint_map as Record<string, unknown>
                  const ancestor = namespace.split("|").slice(0, -1).join("|")
                  await refuse(
                    "forged ancestor map after successful read",
                    {
                      ...config.configurable,
                      checkpoint_map: { ...map, [ancestor]: crypto.randomUUID() },
                    },
                    "stale_generation",
                  )
                  // Native exact-head selection is valid; it is checked before
                  // normalization, then the same owned saver selects implicitly.
                  await readOwned(reader, {
                    ...config,
                    configurable: {
                      ...config.configurable,
                      checkpoint_id: tuple!.checkpoint.id,
                      checkpoint_map: { ...map, [namespace]: tuple!.checkpoint.id },
                    },
                  })
                  await expect(
                    secondReader({
                      ...config,
                      configurable: { ...config.configurable, checkpoint_ns: "sibling:identity" },
                    }),
                  ).rejects.toMatchObject({ code: "not_found" })
                  expect(await store.snapshot()).toEqual(before)
                  expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
                  const selectorOutcomes: Record<string, string> = {}
                  await refuse(
                    "forged explicit selector after successful read",
                    { ...config.configurable, checkpoint_id: crypto.randomUUID() },
                    "stale_generation",
                    selectorOutcomes,
                  )
                  await refuse(
                    "forged own map after successful read",
                    {
                      ...config.configurable,
                      checkpoint_map: { ...map, [namespace]: crypto.randomUUID() },
                    },
                    "stale_generation",
                    selectorOutcomes,
                  )
                  await refuse(
                    "unrelated map key after successful read",
                    {
                      ...config.configurable,
                      checkpoint_map: { ...map, "unrelated:namespace": crypto.randomUUID() },
                    },
                    "stale_generation",
                    selectorOutcomes,
                  )
                  expect(selectorOutcomes).toEqual({
                    "forged explicit selector after successful read": "stale_generation",
                    "forged own map after successful read": "stale_generation",
                    "unrelated map key after successful read": "stale_generation",
                  })
                } catch (error) {
                  failure = error
                  throw error
                }
              }
              return {
                routeId: entry.routeId,
                routeKey: `${entry.routeId}#agent`,
                graph: bound,
              }
            },
          })
          try {
            const graph = await materializeAgentGraph({
              descriptor: agent({ model: "gpt-5-mini", systemPrompt: "root" }),
              checkpointer: saver,
              activeInput: boundary.activeInput,
              subagentResolver: resolver,
              tools: [
                {
                  name: "task",
                  description: "Delegate to owned child.",
                  schema: z.object({ subagent: z.string(), input: z.string() }),
                  async run() {
                    throw new Error("Task placeholder executed")
                  },
                },
              ],
            })
            await bindProtocolAgentExecution({
              store,
              runId: run.run.run_id,
              checkpointer: saver,
              entry: graph,
              config,
            })
            if (mode === "execute")
              await agentBackendAdapter.execute(
                graph,
                continuation?.input ?? run.run.input,
                context,
              )
            else
              for await (const chunk of agentBackendAdapter.stream(
                graph,
                continuation?.input ?? run.run.input,
                context,
              ))
                (continuation ? resumedChunks : sourceChunks).push(chunk as Chunk)
            for (const [requested] of rootReads.mock.calls)
              expect(requested.configurable?.checkpoint_ns ?? "").toBe("")
            if (kind === "reader-authority" && continuation) {
              // The wrapper has retired the child, while the parent invocation
              // still owns the exact Run. A prior successful read grants nothing.
              const before = await store.snapshot()
              const beforeCalls = { calls, attempts, effects, prepared }
              expect(capturedReader).toBeTypeOf("function")
              await expect(capturedReader!()).rejects.toMatchObject({ code: "stale_generation" })
              expect(await store.snapshot()).toEqual(before)
              expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
            }
            if (!continuation) {
              const task = childState?.tasks.find((task) => task.interrupts.length)
              const event = task?.interrupts[0]
              if (!task || !event || !childState || !childNamespace?.length)
                throw new Error("Actual native child permission park missing")
              const nativeBinding = await runtimeNativePermissionBinding(
                saver,
                childState.config.configurable.checkpoint_id,
                task.id,
                event.id,
              )
              const { interruptId, grant: _grant, ...request } = event.value
              if (typeof interruptId !== "string") throw new Error("Invalid owned permission")
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
                      protectedProposal: {},
                      nativeBinding,
                    },
                  ],
                  "required",
                  saver,
                ),
              )
            }
            return {}
          } catch (error) {
            failure = error
            throw error
          } finally {
            park.dispose()
          }
        },
      })
      await host.tick()
      await host.idle()
      if (failure) throw failure
      const parked = await f.snapshot(initial.threadId)
      const pending = parked.pending[0]!
      expect(parked.runs[0]?.metadata.reason).toBe("permission")
      expect(pending.namespace.length).toBeGreaterThan(0)
      expect({ calls, attempts, effects, prepared }).toEqual({
        calls: 2,
        attempts: 1,
        effects: 0,
        prepared: 1,
      })
      const resumed = await permissions.respond(f.request(), initial.threadId, initial.runId, {
        id: 1,
        method: "input.respond",
        params: {
          namespace: pending.namespace,
          interruptId: pending.input.data.interruptId,
          response: { decision: "once", grant: pending.input.data.b4.grant },
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        },
      })
      expect(resumed.runId).not.toBe(initial.runId)
      tools = false
      await host.tick()
      await host.idle()
      if (failure) throw failure
      const final = await f.snapshot(initial.threadId)
      expect(final.runs.find((row) => row.run.run_id === resumed.runId)?.run.status).toBe("success")
      expect(effects).toBe(1)
      expect({ calls, attempts, prepared }).toEqual({ calls: 4, attempts: 2, prepared: 2 })
      expect(final.grants[0]?.consumedByRunId).toBe(resumed.runId)
      if (kind === "reader-authority") {
        const beforeCalls = { calls, attempts, effects, prepared }
        const staleRead = async () => {
          const before = await f.snapshot(initial.threadId)
          await expect(capturedReader!()).rejects.toMatchObject({
            code: expect.stringMatching(/^stale_(fence|generation)$/),
          })
          expect(await f.snapshot(initial.threadId)).toEqual(before)
          expect({ calls, attempts, effects, prepared }).toEqual(beforeCalls)
        }
        // Check the captured immutable handle both after root unwind and after
        // a distinct successor admission. It cannot rebind itself to that Run.
        await staleRead()
        const successor = await f.admit(
          body({
            thread_id: initial.threadId,
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
            on_completion: "keep",
          }),
        )
        expect(successor.runId).not.toBe(resumed.runId)
        await staleRead()
      }
      if (mode === "stream") {
        for (const chunk of sourceChunks.filter((chunk) => chunk.type === "subagent.tool_call"))
          expect(chunk.data).not.toHaveProperty("replayed")
        expect(
          sourceChunks
            .filter((chunk) => chunk.type === "subagent.tool_call")
            .map((chunk) => chunk.data),
        ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "child-effect" })]))
        expect(
          resumedChunks
            .filter((chunk) => chunk.type === "subagent.tool_call")
            .map((chunk) => chunk.data),
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "child-effect", replayed: true })]),
        )
        expect(JSON.stringify(resumedChunks)).not.toContain("subagent_failed:")
      }
    } finally {
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
