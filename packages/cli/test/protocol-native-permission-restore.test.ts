import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  __resetApprovalGrantsForTests,
  configureApprovalGrants,
  wrapToolWithApproval,
  wrapToolWithConstraint,
} from "@b4run/core"
import { materializeAgentGraph } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { createPermissionsStore } from "@b4run/permissions/node"
import { APPROVAL_GRANT_MINTER_KEY, agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { getConfig } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import {
  createRuntimeCheckpointSaver,
  runtimeNativePermissionBinding,
  runtimePermissionResolver,
} from "../src/lib/runtime/checkpoint-saver.ts"
import {
  bindProtocolAgentExecution,
  rebindStoppedCheckpoint,
} from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary, createInputService } from "../src/lib/runtime/inputs.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture, reportOwnedCleanup } from "./fixtures/protocol-admission.ts"
import { rejectStoppedSourceFaults } from "./fixtures/protocol-source-faults.ts"

interface NativeCase {
  readonly sourceMode: "off" | "optional" | "required"
  readonly acceptMode: "off" | "optional" | "required"
  readonly decision: "once" | "always" | "deny"
  readonly expired: boolean
  readonly refusal: "grant_invalid" | "grant_expired" | null
  readonly restriction?: "deny" | "constraint" | "removeAlways"
  readonly priorInput?: boolean
  readonly stopBeforeStart?: boolean
  readonly transport?: "stream"
  readonly stopDuringResume?: boolean
  readonly ownershipLost?: "running" | "settled"
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.doUnmock("@langchain/openai")
  __resetApprovalGrantsForTests()
})
it.each([
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
  },
  { sourceMode: "required", acceptMode: "off", decision: "once", expired: false, refusal: null },
  { sourceMode: "optional", acceptMode: "off", decision: "once", expired: false, refusal: null },
  {
    sourceMode: "optional",
    acceptMode: "optional",
    decision: "once",
    expired: false,
    refusal: null,
  },
  { sourceMode: "off", acceptMode: "optional", decision: "once", expired: false, refusal: null },
  {
    sourceMode: "off",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: "grant_invalid",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "deny",
    expired: true,
    refusal: null,
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: true,
    refusal: "grant_expired",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    restriction: "deny",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    restriction: "constraint",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "always",
    expired: false,
    refusal: null,
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "always",
    expired: false,
    refusal: null,
    restriction: "removeAlways",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    priorInput: true,
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    stopBeforeStart: true,
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    transport: "stream",
  },
  {
    sourceMode: "required",
    acceptMode: "required",
    decision: "once",
    expired: false,
    refusal: null,
    stopDuringResume: true,
  },
  ...(process.env.B4_ADMISSION_POSTGRES === "1"
    ? ([
        {
          sourceMode: "required",
          acceptMode: "required",
          decision: "once",
          expired: false,
          refusal: null,
          stopDuringResume: true,
          ownershipLost: "running",
        },
        {
          sourceMode: "required",
          acceptMode: "required",
          decision: "once",
          expired: false,
          refusal: null,
          stopDuringResume: true,
          ownershipLost: "settled",
        },
      ] as const)
    : []),
] satisfies readonly NativeCase[])(
  "restores native core permission ($sourceMode->$acceptMode/$decision/expired:$expired/restriction:$restriction/priorInput:$priorInput/stopBeforeStart:$stopBeforeStart/transport:$transport/stopDuringResume:$stopDuringResume/loss:$ownershipLost)",
  async (testCase: NativeCase) => {
    const { sourceMode, acceptMode, decision, expired, refusal, restriction, priorInput } = testCase
    __resetApprovalGrantsForTests()
    const f = await fixture()
    let primary: { readonly error: unknown } | undefined
    const entered = deferred(),
      release = deferred(),
      releaseEntered = deferred(),
      releaseOwner = deferred()
    let releaseSpy: { mockRestore(): void } | undefined,
      recovery: ReturnType<typeof createExecutionHost> | undefined
    let cancellation:
      | Promise<
          | { readonly ok: true; readonly value: unknown }
          | { readonly ok: false; readonly error: unknown }
        >
      | undefined
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      effects = 0,
      failure: unknown
    let nativeTask = "",
      nativeNs = "",
      nativeIndex = 0,
      gateError: unknown,
      constrained = false,
      ruleRemoved = false
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "native-core-restore"
      }
      bindTools() {
        return this
      }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        calls++
        return {
          generations: [
            {
              text: "",
              message:
                priorInput && calls === 1
                  ? new AIMessage({
                      content: "",
                      tool_calls: [{ id: "inspect-call", name: "inspect", args: {} }],
                    })
                  : calls === (priorInput ? 2 : 1)
                    ? new AIMessage({
                        content: "",
                        tool_calls: [{ id: "protect-call", name: "protect", args: {} }],
                      })
                    : new AIMessage("done"),
            },
          ],
        }
      }
      async *_streamResponseChunks(
        messages: BaseMessage[],
        _options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ) {
        const message = (await this._generate(messages)).generations[0]!.message as AIMessage
        const chunk = new ChatGenerationChunk({
          text: typeof message.content === "string" ? message.content : "",
          message: new AIMessageChunk({
            content: message.content,
            ...(message.tool_calls?.length
              ? {
                  tool_call_chunks: message.tool_calls.map((call, index) => ({
                    id: call.id!,
                    name: call.name,
                    args: JSON.stringify(call.args),
                    index,
                  })),
                }
              : {}),
          }),
        })
        yield chunk
        if (chunk.text)
          await runManager?.handleLLMNewToken(
            chunk.text,
            undefined,
            undefined,
            undefined,
            undefined,
            { chunk },
          )
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      const injection = createInputService({
        ...f.authority,
        resolveTarget: async ({ run }) => ({
          adapter: agentBackendAdapter,
          agentId: run.run.agent_id!,
          namespaceGeneration: run.run.run_id,
          systemInjection: false,
        }),
      })
      let rules =
        f.native.ruleStore() ??
        createPermissionsStore({ appRoot: f.directory, config: undefined, mode: "interactive" })
      const sourceRules = rules
      const setPolicy = async (action: "removeAllow" | "deny") => {
        if (!(await f.native.editRule(action, "tool", "protect"))) {
          const path = join(f.directory, ".b4", "permissions.json"),
            current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1 }
          writeFileSync(
            path,
            JSON.stringify({
              ...current,
              allow: {},
              deny: action === "deny" ? { tool: ["protect"] } : {},
            }),
          )
        }
      }
      const afterRuleApply = async (point: string) => {
        if (restriction === "removeAlways" && point === "afterRuleApply") {
          await setPolicy("removeAllow")
          ruleRemoved = true
        }
      }
      let permissions = createPermissionService({
        ...f.authority,
        grants: sourceMode,
        resolvePermissions: async () => rules,
        failpoint: afterRuleApply,
      })
      const rawTool = {
        name: "protect",
        description: "Protected action.",
        run: async (_input: unknown, _context: unknown) => {
          effects++
          if (testCase.stopDuringResume) {
            entered.resolve()
            await release.promise
          }
          return "protected effect"
        },
      }
      const makeTool = () => {
        const gated =
          restriction === "constraint"
            ? wrapToolWithConstraint(
                rawTool,
                () => (constrained ? "Current constraint denies" : { approve: true }),
                rules,
                "/chat",
              )
            : wrapToolWithApproval(rawTool, rules)
        const tool = {
          ...gated,
          async run(input: unknown, context: unknown) {
            const configurable = getConfig()?.configurable
            if (!configurable) throw new Error("Missing actual native tool configuration")
            nativeTask = String(configurable?.__pregel_task_id)
            nativeNs = String(configurable?.checkpoint_ns)
            nativeIndex =
              Number(
                (configurable.__pregel_scratchpad as { interruptCounter: number }).interruptCounter,
              ) + 1
            try {
              return await gated.run(input, context as { signal: AbortSignal })
            } catch (error) {
              gateError = error
              throw error
            }
          },
        }
        return tool
      }
      host = createExecutionHost({
        ...f.authority,
        permissions,
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
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Native permissions." }),
            checkpointer,
            activeInput: boundary.activeInput,
            tools: [
              makeTool(),
              {
                name: "inspect",
                description: "Inject before permission park.",
                async run() {
                  await injection.inject(f.request(), accepted.threadId, accepted.runId, {
                    namespace: [],
                    message: {
                      role: "user",
                      content: "applied source steering",
                      b4: { v: 1, submissionId: crypto.randomUUID() },
                    },
                  })
                  return "observed"
                },
              },
            ],
          })) as {
            invoke(input: unknown, config: unknown): Promise<unknown>
            getState(config: unknown): Promise<{
              config: { configurable: { checkpoint_id: string } }
              tasks: {
                id: string
                interrupts: {
                  id: string
                  value: {
                    interruptId: string
                    grant?: string
                    kind: "tool"
                    detail: { toolName: string; suggestedPattern: string }
                  }
                }[]
              }[]
            }>
          }
          const continuation = run.metadata.previousRunId
            ? await permissions.prepareNativeContinuation(store, checkpointer, run.run.run_id)
            : undefined
          const parkMinter = permissions.createNativeParkMinter(store, checkpointer, run.run.run_id)
          const config = {
            configurable: {
              thread_id: accepted.threadId,
              checkpoint_ns: "",
              ...continuation?.configurable,
              ...parkMinter.configurable,
              ...(parkMinter.minter ? { [APPROVAL_GRANT_MINTER_KEY]: parkMinter.minter } : {}),
            },
            signal,
            durability: "sync",
          }
          try {
            if (run.metadata.previousRunId && restriction === "deny") await setPolicy("deny")
            await bindProtocolAgentExecution({
              store,
              runId: run.run.run_id,
              checkpointer,
              entry: graph,
              config,
            })
            if (testCase.transport === "stream") {
              const chunks: { type?: string; data?: unknown }[] = []
              for await (const chunk of agentBackendAdapter.stream(
                graph,
                continuation?.input ?? run.run.input,
                { signal },
              ))
                chunks.push(chunk as { type?: string; data?: unknown })
              expect(chunks.filter((chunk) => chunk.type === "done")).toHaveLength(1)
              if (run.run.run_id === accepted.runId) {
                expect(chunks.filter((chunk) => chunk.type === "interrupt")).toHaveLength(1)
                expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1)
              } else {
                expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
                  expect.objectContaining({
                    data: expect.objectContaining({ id: "protect-call", replayed: true }),
                  }),
                ])
                expect(
                  chunks
                    .filter((chunk) => chunk.type === "token")
                    .map((chunk) => chunk.data)
                    .join(""),
                ).toBe("done")
                expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
              }
            } else
              await agentBackendAdapter.execute(graph, continuation?.input ?? run.run.input, {
                signal,
              })
            if (run.run.run_id === accepted.runId) {
              const state = await graph.getState(config),
                task = state.tasks.find((row) => row.interrupts.length),
                parked = task?.interrupts[0]
              if (!parked || !task)
                throw gateError ?? new Error("Missing real core permission checkpoint")
              expect(task.id).toBe(nativeTask)
              expect(nativeNs).toContain(task.id)
              const nativeBinding = await runtimeNativePermissionBinding(
                checkpointer,
                state.config.configurable.checkpoint_id,
                task.id,
                parked.id,
              )
              expect(nativeBinding.interruptIndex).toBe(nativeIndex)
              const proposal = {
                namespace: [],
                interruptId: parked.value.interruptId,
                request: (() => {
                  const { interruptId: _id, grant: _grant, ...request } = parked.value
                  return request
                })(),
                ...(expired ? { expiresAt: new Date(Date.now() - 60_000).toISOString() } : {}),
                protectedProposal: {},
                nativeBinding,
              }
              const before = await store.snapshot()
              for (const invalid of [
                { ...nativeBinding, taskId: crypto.randomUUID() },
                { ...nativeBinding, namespaceGeneration: crypto.randomUUID() },
                { ...nativeBinding, checkpointNs: `forged:${crypto.randomUUID()}` },
              ])
                await expect(
                  store.transaction((tx) =>
                    parkPermissions(
                      tx,
                      run.run.run_id,
                      [{ ...proposal, nativeBinding: invalid }],
                      sourceMode,
                      checkpointer,
                    ),
                  ),
                ).rejects.toMatchObject({ code: "approval_changed" })
              const fault = new Error("native-park-before-commit")
              await expect(
                store.transaction(async (tx) => {
                  await parkPermissions(tx, run.run.run_id, [proposal], sourceMode, checkpointer)
                  throw fault
                }),
              ).rejects.toBe(fault)
              expect(await store.snapshot()).toEqual(before)
              await store.transaction((tx) =>
                parkPermissions(tx, run.run.run_id, [proposal], sourceMode, checkpointer),
              )
            }
          } catch (error) {
            failure = error
            throw error
          } finally {
            parkMinter.dispose()
            if (parkMinter.minter)
              await expect(
                parkMinter.minter.mint({ interruptId: "disposed", checkpointNs: nativeNs }),
              ).rejects.toMatchObject({ code: "stale_generation" })
          }
          return {}
        },
      })
      configureApprovalGrants(sourceMode)
      await host.tick()
      await host.idle()
      if (failure) throw failure
      expect(effects).toBe(0)
      const parked = await f.snapshot(accepted.threadId),
        pending = parked.pending[0]!
      if (sourceMode === "off") expect(pending.input.data.b4.grant).toBeUndefined()
      else expect(pending.input.data.b4.grant).toEqual(expect.any(String))
      expect(parked.grants).toHaveLength(sourceMode === "off" ? 0 : 1)
      permissions = createPermissionService({
        ...f.authority,
        grants: acceptMode,
        resolvePermissions: async () => rules,
      })
      const command = {
        id: 1,
        method: "input.respond",
        params: {
          namespace: [],
          interruptId: pending.input.data.interruptId,
          response: {
            decision,
            ...(pending.input.data.b4.grant ? { grant: pending.input.data.b4.grant } : {}),
          },
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        },
      }
      if (refusal) {
        await expect(
          permissions.respond(f.request(), accepted.threadId, accepted.runId, command),
        ).rejects.toMatchObject({ code: refusal })
        const after = await f.snapshot(accepted.threadId)
        expect(after.runs).toHaveLength(1)
        expect(after.grants.every((grant) => grant.consumedByRunId === null)).toBe(true)
        expect(effects).toBe(0)
        return
      }
      const resumed = await permissions.respond(
        f.request(),
        accepted.threadId,
        accepted.runId,
        command,
      )
      let store = await f.store(accepted.threadId)
      const receipt = (await store.snapshot()).receipts.find(
        (row) => row.receipt.runId === resumed.runId,
      )!
      expect(receipt.operation?.permissionBindings).toHaveLength(1)
      const bindings = receipt.operation!.permissionBindings!
      await expect(
        store.transaction((tx) =>
          tx.receipts.put({
            ...receipt,
            operation: {
              ...receipt.operation!,
              permissionBindings: [
                { ...bindings[0]!, decision: decision === "deny" ? "once" : "deny" },
              ],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      const { permissionBindings: _proof, ...withoutProof } = receipt.operation!
      await expect(
        store.transaction((tx) => tx.receipts.put({ ...receipt, operation: withoutProof })),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      expect(
        (await store.snapshot()).receipts.find((row) => row.receiptId === receipt.receiptId),
      ).toEqual(receipt)
      if (testCase.stopBeforeStart || testCase.stopDuringResume) {
        if (testCase.stopDuringResume) {
          if (testCase.ownershipLost === "settled") {
            const execution = runtimeStorageRegistration(f.storage).execution!
            const claim = execution.claim.bind(execution)
            releaseSpy = vi.spyOn(execution, "claim").mockImplementation(async (...args) => {
              const lease = await claim(...args)
              if (!lease || args[1] !== host!.ownerId) return lease
              return {
                ...lease,
                async release(callback) {
                  releaseEntered.resolve()
                  await releaseOwner.promise
                  return lease.release(callback)
                },
              }
            })
          }
          await host.tick()
          await Promise.race([
            entered.promise,
            host.idle().then(() => {
              throw failure ?? new Error("Resume finished before raw tool barrier")
            }),
          ])
          if (testCase.ownershipLost !== "running") {
            cancellation = host
              .cancel(f.request(), accepted.threadId, resumed.runId, { wait: true })
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              )
            expect(
              await Promise.race([
                cancellation.then(() => "settled"),
                new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
              ]),
            ).toBe("held")
          }
          const activeStore = await f.store(accepted.threadId),
            activeSnapshot = await activeStore.snapshot(),
            active = activeSnapshot.runs.find((row) => row.run.run_id === resumed.runId)!
          expect(await activeStore.transaction((tx) => tx.executionOwner())).not.toBeNull()
          if (testCase.ownershipLost) {
            if (testCase.ownershipLost === "settled") {
              release.resolve()
              await releaseEntered.promise
            }
            await f.native.expireOwner(accepted.threadId)
            let reexecutions = 0
            recovery = createExecutionHost({
              ...f.authority,
              permissions,
              async invoke() {
                reexecutions++
                throw new Error("Lost native task must never dispatch")
              },
            })
            const recoveryError = await recovery.tick().then(
              () => undefined,
              (error: unknown) => error,
            )
            expect(recoveryError).toMatchObject({
              code: "storage_unavailable",
              message: "Expired execution ownership awaits durable reconciliation",
            })
            await recovery.idle()
            const recovered = (await f.snapshot(accepted.threadId)).runs.find(
              (row) => row.run.run_id === resumed.runId,
            )!
            expect(reexecutions).toBe(0)
            expect(recovered.ownershipLoss).toMatchObject({
              ownerId: active.execution!.ownerId,
              fence: active.execution!.fence,
              effectsUncertain: true,
              detectedAt: expect.any(String),
            })
            expect(recovered.execution!.fence).toBeGreaterThan(active.execution!.fence)
            const recoveredOwnership = await (await f.store(accepted.threadId)).transaction(
              async (tx) => ({ owner: await tx.executionOwner(), fence: tx.scope.fence }),
            )
            expect(recoveredOwnership.owner).toBeNull()
            expect(recoveredOwnership.fence).toBe(recovered.execution!.fence + 1)
            expect(recovered.metadata.reason).toBe(
              testCase.ownershipLost === "settled" ? "user_stop" : "execution_lost",
            )
            release.resolve()
            releaseOwner.resolve()
            await host.idle()
            if (cancellation) {
              expect(await cancellation).toMatchObject({
                ok: false,
                error: { code: "storage_unavailable" },
              })
              cancellation = undefined
            }
            releaseSpy?.mockRestore()
            releaseSpy = undefined
          } else {
            release.resolve()
            expect(await cancellation).toMatchObject({ ok: true })
            await host.idle()
          }
          expect(effects).toBe(1)
          expect(calls).toBe(1)
          expect(failure).toBeDefined()
          failure = undefined
        } else await host.cancel(f.request(), accepted.threadId, resumed.runId, { wait: true })
        store = await f.store(accepted.threadId)
        const before = await store.snapshot(),
          stopped = before.runs.find((row) => row.run.run_id === resumed.runId)!
        if (testCase.stopDuringResume)
          expect(stopped.metadata.startedAt).toEqual(expect.any(String))
        else expect(stopped.metadata.startedAt).toBeUndefined()
        expect(stopped.metadata.reason).toBe(
          testCase.ownershipLost === "running" ? "execution_lost" : "user_stop",
        )
        if (!testCase.ownershipLost) expect(stopped.unwoundAt).toEqual(expect.any(String))
        expect(
          before.checkpoints.find(
            (row) => row.state.checkpoint.checkpoint_id === before.thread?.headCheckpointId,
          )?.ownerRunId,
        ).toBe(accepted.runId)
        const saver = createRuntimeCheckpointSaver({ store, runId: resumed.runId, namespace: [] })
        const graph = await materializeAgentGraph({
          descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Native permissions." }),
          checkpointer: saver,
          activeInput: createActiveInputBoundary({
            store,
            runId: resumed.runId,
            namespace: [],
            namespaceGeneration: resumed.runId,
          }).activeInput,
          tools: [makeTool()],
        })
        const rebindOptions = {
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
        const fault = new Error("accepted-native-rebind-rollback")
        await expect(
          rebindStoppedCheckpoint({
            ...rebindOptions,
            failpoint() {
              throw fault
            },
          }),
        ).rejects.toBe(fault)
        expect(await store.snapshot()).toEqual(before)
        await rebindStoppedCheckpoint(rebindOptions)
        const binding = pending.proposal!.nativeBinding!
        await expect(
          runtimePermissionResolver(saver)({
            runId: resumed.runId,
            checkpointId: binding.checkpointId,
            checkpointNs: binding.checkpointNs,
            nativeTaskId: binding.taskId,
            interruptIndex: binding.interruptIndex,
            request: (pending.input.data.payload as { request: Readonly<Record<string, unknown>> })
              .request,
            protectedProposal: pending.proposal!.value,
            rule: pending.proposal!.rule,
          }),
        ).rejects.toMatchObject({ code: "not_supported" })
        await rejectStoppedSourceFaults(f, accepted.threadId, store)
        expect((await store.snapshot()).grants).toEqual(before.grants)
        if (testCase.stopDuringResume) {
          const safeSnapshot = await store.snapshot(),
            physical = safeSnapshot.checkpoints.find(
              (row) => row.state.checkpoint.checkpoint_id === before.thread!.headCheckpointId,
            )!
          const writes = (
            physical.payload as {
              writes: {
                kind: string
                ownerRunId: string
                fence: number
                sourceCheckpointId: string | null
              }[]
            }
          ).writes.filter((write) => write.ownerRunId === resumed.runId)
          expect(
            writes.some(
              (write) =>
                write.kind === "execution" &&
                write.fence === (stopped.ownershipLoss?.fence ?? stopped.execution!.fence),
            ),
          ).toBe(true)
          const administrativeFence = await store.transaction(async (tx) => tx.scope.fence)
          expect(
            writes.some(
              (write) => write.kind === "administrative" && write.fence === administrativeFence,
            ),
          ).toBe(true)
          expect(
            writes.every(
              (write) => write.sourceCheckpointId === physical.state.checkpoint.checkpoint_id,
            ),
          ).toBe(true)
        }
        const freshToken = crypto.randomUUID()
        const fresh = await f.admit(
          body({
            thread_id: accepted.threadId,
            metadata: { b4: { v: 1, submissionId: freshToken } },
            on_completion: "keep",
          }),
        )
        await host.tick()
        await host.idle()
        if (failure) throw failure
        expect(
          (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === fresh.runId)
            ?.run.status,
        ).toBe("success")
        expect(effects).toBe(testCase.stopDuringResume ? 1 : 0)
        expect(calls).toBe(2)
        if (testCase.stopDuringResume) {
          const final = await f.snapshot(accepted.threadId),
            generation = final.scope.generation
          const historical = final.runs.find((row) => row.run.run_id === resumed.runId)!
          expect(historical.ownershipLoss).toEqual(stopped.ownershipLoss)
          expect(historical.metadata).toEqual(stopped.metadata)
          for (const id of [accepted.runId, resumed.runId])
            await f.native.removeLiveRunPayload(accepted.threadId, generation, id)
          expect(await f.lookup(freshToken)).toHaveLength(1)
          f.removeAgent("/chat#agent")
          expect(await f.lookup(freshToken)).toEqual([])
          await f.native.corruptProtectedSourceDigest(accepted.threadId, generation, fresh.runId)
          expect(await f.lookup(freshToken)).toEqual([])
          f.restoreAgent("/chat#agent")
          await expect(f.lookup(freshToken)).rejects.toMatchObject({ code: "storage_unavailable" })
        }
        return
      }
      configureApprovalGrants("required")
      // Accepted slot authority uses its immutable acceptance mode even if the
      // current server requires grants when this queued continuation dispatches.
      permissions = createPermissionService({
        ...f.authority,
        grants: "required",
        resolvePermissions: async () => rules,
        failpoint: afterRuleApply,
      })
      rules =
        f.native.ruleStore() ??
        createPermissionsStore({ appRoot: f.directory, config: undefined, mode: "interactive" })
      expect(rules).not.toBe(sourceRules)
      if (decision === "always" && !restriction && (await f.native.ruleWriteFault(true))) {
        try {
          await expect(host.tick()).rejects.toThrow("R8 owned rule receipt I/O")
          const unstarted = (await f.snapshot(accepted.threadId)).runs.find(
            (row) => row.run.run_id === resumed.runId,
          )!
          expect(unstarted.metadata.phase).toBe("accepted")
          expect(unstarted.metadata.startedAt).toBeUndefined()
          expect(effects).toBe(0)
          expect(calls).toBe(1)
          expect(await f.native.ruleRows()).toEqual([])
          expect(
            (await permissions.respond(f.request(), accepted.threadId, accepted.runId, command))
              .runId,
          ).toBe(resumed.runId)
        } finally {
          await f.native.ruleWriteFault(false)
        }
        rules = f.native.ruleStore()!
      }
      constrained = restriction === "constraint"
      await host.tick()
      await host.idle()
      if (failure) throw failure
      if (restriction === "removeAlways") {
        expect(ruleRemoved).toBe(true)
        await rules.load()
        expect(rules.match("tool", "protect")).toBe("unknown")
        const intent = (
          (await f.snapshot(accepted.threadId)).inbox.find((row) => row.kind === "rule_intent")!
            .payload as { intent: import("@b4run/permissions").RememberedRuleIntent }
        ).intent
        expect(await rules.rememberedRules!.apply(intent)).toBe("applied")
        await rules.load()
        expect(rules.match("tool", "protect")).toBe("unknown")
        if (f.native.workerBoot) expect(await f.native.ruleRows()).toEqual([])
      }
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === resumed.runId)
          ?.run.status,
      ).toBe("success")
      expect(effects).toBe(decision === "deny" || restriction ? 0 : 1)
      expect(calls).toBe(priorInput ? 3 : 2)
      const final = await f.snapshot(accepted.threadId)
      const source = final.checkpoints.find(
        (row) =>
          row.state.checkpoint.checkpoint_id ===
          final.runs.find((row) => row.run.run_id === resumed.runId)?.preRunCheckpointId,
      )
      if (!source) throw new Error("Missing actual source checkpoint")
      expect(source.ownerRunId).toBe(accepted.runId)
      expect(
        (source.payload as { writes: { ownerRunId: string }[] }).writes.some(
          (write) => write.ownerRunId === resumed.runId,
        ),
      ).toBe(true)
      expect(JSON.stringify(final.checkpoints)).not.toContain("__b4PermissionContinuation")
      expect(agentBackendAdapter.protocol?.injection).toBe("before_model")
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      release.resolve()
      releaseOwner.resolve()
      releaseSpy?.mockRestore()
      const owners = await Promise.allSettled([host?.idle(), cancellation, recovery?.idle()])
      const closed = await Promise.allSettled([host?.close(), recovery?.close()])
      const fixtureClosed = await Promise.allSettled([f.close()])
      const errors = [...owners, ...closed, ...fixtureClosed]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
      reportOwnedCleanup("Native Core fixture cleanup failed", errors, primary)
    }
  },
  30_000,
)
