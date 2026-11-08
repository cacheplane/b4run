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
import { afterEach, expect, it, vi } from "vitest"
import { gatePathOp } from "../../core/dist/capabilities/permission-gate.js"
import {
  createRuntimeCheckpointSaver,
  runtimeNativePermissionBinding,
} from "../src/lib/runtime/checkpoint-saver.ts"
import { bindProtocolAgentExecution } from "../src/lib/runtime/execute-route-core.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary } from "../src/lib/runtime/inputs.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  __resetApprovalGrantsForTests()
})

it.each(["off", "required"] as const)(
  "restores exact accepted index lineage across identical native gates (%s)",
  async (mode) => {
    __resetApprovalGrantsForTests()
    configureApprovalGrants(mode)
    const f = await fixture()
    let host: ReturnType<typeof createExecutionHost> | undefined,
      calls = 0,
      siblings = 0,
      bodies = 0,
      prefixes = 0,
      effects = 0,
      failure: unknown
    const positions: number[] = [],
      taskIds: string[] = [],
      checkpointIds: string[] = []
    let finalRunId: string | undefined
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "native-index-chain"
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
                calls === 1
                  ? new AIMessage({
                      content: "",
                      tool_calls: [
                        { id: "sibling-call", name: "finishSibling", args: {} },
                        { id: "protect-call", name: "protect", args: {} },
                      ],
                    })
                  : new AIMessage("done"),
            },
          ],
        }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      const rules =
        f.native.ruleStore() ??
        createPermissionsStore({ appRoot: f.directory, config: undefined, mode: "interactive" })
      const permissions = createPermissionService({
        ...f.authority,
        grants: mode,
        resolvePermissions: async () => rules,
      })
      const protectedTool = wrapToolWithApproval(
        {
          name: "protect",
          description: "Two identical resource gates.",
          async run() {
            bodies++
            if (
              !(await gatePathOp(rules, "writeFile", "/outside/result.txt", "/workspace")).allowed
            )
              return "denied"
            prefixes++
            if ((await gatePathOp(rules, "writeFile", "/outside/result.txt", "/workspace")).allowed)
              effects++
            return "done"
          },
        },
        rules,
      )
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
          const saver = createRuntimeCheckpointSaver({
            store,
            runId: run.run.run_id,
            namespace: [],
            commitInputs: boundary.commitInputs,
          })
          const graph = (await materializeAgentGraph({
            descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Native gate lineage." }),
            checkpointer: saver,
            activeInput: boundary.activeInput,
            tools: [
              {
                name: "finishSibling",
                description: "Completed sibling.",
                async run() {
                  siblings++
                  return "completed sibling"
                },
              },
              protectedTool,
            ],
          })) as {
            invoke(input: unknown, config: unknown): Promise<unknown>
            getState(config: unknown): Promise<{
              config: { configurable: { checkpoint_id: string } }
              tasks: {
                id: string
                interrupts: { id: string; value: { interruptId: string; grant?: string } }[]
              }[]
            }>
          }
          const continuation = run.metadata.previousRunId
            ? await permissions.prepareNativeContinuation(store, saver, run.run.run_id)
            : undefined
          const invocation = permissions.createNativeParkMinter(store, saver, run.run.run_id)
          const config = {
            configurable: {
              thread_id: accepted.threadId,
              checkpoint_ns: "",
              ...continuation?.configurable,
              ...invocation.configurable,
              ...(invocation.minter ? { [APPROVAL_GRANT_MINTER_KEY]: invocation.minter } : {}),
              ...(continuation
                ? {
                    checkpoint_id: run.preRunCheckpointId,
                    checkpoint_map: { "": run.preRunCheckpointId },
                  }
                : {}),
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
            const {
              checkpoint_id: _selected,
              checkpoint_map: _map,
              ...configurable
            } = config.configurable
            const state = await graph.getState({ ...config, configurable }),
              interrupted = state.tasks.filter((task) => task.interrupts.length)
            if (!interrupted.length) {
              expect(effects, JSON.stringify(output)).toBe(1)
              return {}
            }
            expect(interrupted).toHaveLength(1)
            const task = interrupted[0]!,
              parked = task.interrupts[0]!
            expect(task.interrupts).toHaveLength(1)
            const nativeBinding = await runtimeNativePermissionBinding(
              saver,
              state.config.configurable.checkpoint_id,
              task.id,
              parked.id,
            )
            positions.push(nativeBinding.interruptIndex)
            taskIds.push(task.id)
            checkpointIds.push(nativeBinding.checkpointId)
            const { interruptId, grant: _grant, ...request } = parked.value
            const detail = request as {
              kind?: string
              detail?: { operation: string; path: string }
            }
            const proposal = {
              namespace: [],
              interruptId,
              request,
              protectedProposal:
                detail.kind === "path"
                  ? { operation: detail.detail!.operation, path: detail.detail!.path }
                  : {},
              nativeBinding,
            }
            const before = await store.snapshot()
            await expect(
              store.transaction((tx) =>
                parkPermissions(
                  tx,
                  run.run.run_id,
                  [
                    {
                      ...proposal,
                      nativeBinding: {
                        ...nativeBinding,
                        interruptIndex: nativeBinding.interruptIndex + 1,
                      },
                    },
                  ],
                  mode,
                  saver,
                ),
              ),
            ).rejects.toMatchObject({ code: "approval_changed" })
            const after = await store.snapshot()
            expect(after.pending).toEqual(before.pending)
            expect(after.grants).toEqual(before.grants)
            await store.transaction((tx) =>
              parkPermissions(tx, run.run.run_id, [proposal], mode, saver),
            )
            return {}
          } catch (error) {
            failure = error
            throw error
          } finally {
            invocation.dispose()
          }
        },
      })
      for (let position = 0; position < 3; position++) {
        await host.tick()
        await host.idle()
        if (failure)
          throw new Error(
            `Explicit root selection failed with completed sibling count ${siblings}, pending body count ${bodies}, effects ${effects}`,
            { cause: failure },
          )
        const snapshot = await f.snapshot(accepted.threadId),
          pending = snapshot.pending.find((row) => row.disposition === "pending")!
        expect(positions, JSON.stringify(snapshot.runs)).toEqual(
          Array.from({ length: position + 1 }, (_, index) => index),
        )
        expect(siblings).toBe(1)
        expect(effects).toBe(0)
        expect(prefixes).toBe(position === 2 ? 1 : 0)
        expect(snapshot.grants).toHaveLength(mode === "off" ? 0 : position + 1)
        finalRunId = (
          await permissions.respond(f.request(), accepted.threadId, pending.ownerRunId, {
            id: 1,
            method: "input.respond",
            params: {
              namespace: [],
              interruptId: pending.input.data.interruptId,
              response: {
                decision: "once",
                ...(pending.input.data.b4.grant ? { grant: pending.input.data.b4.grant } : {}),
              },
              metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
            },
          })
        ).runId
      }
      await host.tick()
      await host.idle()
      if (failure) throw failure
      expect(new Set(taskIds).size).toBe(1)
      expect(new Set(checkpointIds).size).toBe(1)
      expect(siblings).toBe(1)
      expect(bodies).toBe(3)
      expect(prefixes).toBe(2)
      expect(effects).toBe(1)
      expect(calls).toBe(2)
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((row) => row.run.run_id === finalRunId)?.run
          .status,
      ).toBe("success")
    } finally {
      await host?.close()
      await f.close()
    }
  },
  30_000,
)
