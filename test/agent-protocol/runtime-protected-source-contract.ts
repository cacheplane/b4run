/** Canonical storage proof tests, not a native scheduler or HTTP qualification.
 * Both backends use their real internal factory/transactions. The later packed
 * native lifecycle separately proves that LangGraph produces these records. */
import type {
  RuntimeCheckpointRecord,
  RuntimePendingRecord,
  RuntimeProtectedSourceRecord,
  RuntimeRunRecord,
  RuntimeStoppedSourceProof,
} from "@b4run/sdk/agent-protocol"
import {
  protectedSourceDigest,
  protectedSourceId,
  runtimePermissionProposalHash,
} from "@b4run/sdk/internal/runtime-identity"
import { sha256Hex } from "@b4run/sdk/pure"
import { describe, expect, it } from "vitest"
import type { RuntimeStorageContractOptions } from "./runtime-storage-contract.ts"

const cases = [
  "singleton",
  "batch",
  "duplicate-selected",
  "duplicate-sibling",
  "nested-batch",
  "wrong-request",
  "wrong-token",
  "wrong-owner",
  "wrong-epoch",
  "wrong-task",
] as const
type Shape = (typeof cases)[number]

export function declareNativeProtectedSourceContract(options: RuntimeStorageContractOptions) {
  describe("native protected-source storage contract", () => {
    it.each(cases)(
      "seals only the exact accepted native permission source: %s",
      async (shape: Shape) => {
        const { ids, now } = options
        const f = await options.createBackend({ ids, now })
        const timestamp = now(),
          originId = crypto.randomUUID(),
          safeId = crypto.randomUUID(),
          targetId = crypto.randomUUID()
        const receiptId = sha256Hex("accepted-native-permission-receipt")
        const token = "a".repeat(64),
          taskId = "native-tool-task",
          interruptId = "native-interrupt"
        const request = {
          kind: "tool",
          detail: { toolName: "protect", suggestedPattern: "resource" },
        }
        const nativeBinding = {
          checkpointId: originId,
          checkpointNs: "",
          taskId,
          interruptId,
          namespaceGeneration: ids.predecessor,
          interruptIndex: 0,
        }
        const provisional: RuntimePendingRecord = {
          input: {
            namespace: [],
            runId: ids.predecessor,
            turnId: ids.predecessor,
            data: {
              interruptId: ids.firstInput,
              payload: {
                type: "b4.permission",
                v: 1,
                request,
                responseSchema: {},
                allowedDecisions: ["once", "deny"],
                allowAlways: true,
              },
              b4: {
                v: 1,
                pausedGeneration: ids.pausedGeneration,
                proposalHash: "pending",
                status: "resolved",
              },
            },
          },
          ownerRunId: ids.predecessor,
          namespace: [],
          disposition: "answered",
          decision: "once",
          proposal: {
            agentId: "/test#agent",
            value: {},
            rule: { tool: "tool", pattern: "resource" },
            nativeBinding,
          },
        }
        const proposalHash = runtimePermissionProposalHash(provisional)
        const pending: RuntimePendingRecord = {
          ...provisional,
          input: {
            ...provisional.input,
            data: { ...provisional.input.data, b4: { ...provisional.input.data.b4, proposalHash } },
          },
        }
        const proof: RuntimeStoppedSourceProof = {
          v: 1,
          kind: "accepted_not_started",
          creatorMethod: "input.respond",
          path: [
            {
              runId: ids.continuation,
              previousRunId: ids.predecessor,
              receiptId,
              selectedHead: originId,
              protectedSource: null,
            },
          ],
        }
        const baseRun = (id: string): RuntimeRunRecord => ({
          run: {
            run_id: id,
            thread_id: ids.thread,
            agent_id: "/test#agent",
            created_at: timestamp,
            updated_at: timestamp,
            status: "pending",
            metadata: {},
          },
          metadata: {
            v: 1,
            generation: ids.generation,
            turnId: id,
            phase: "accepted",
            continuation: "none",
            acceptedAt: timestamp,
            effectsUncertain: false,
          },
          namespace: [],
          preRunCheckpointId: null,
          result: null,
        })
        const original = baseRun(ids.predecessor),
          stopped = baseRun(ids.continuation)
        const source: RuntimeRunRecord = {
          ...stopped,
          run: { ...stopped.run, status: "interrupted" },
          metadata: {
            ...stopped.metadata,
            turnId: ids.predecessor,
            previousRunId: ids.predecessor,
            phase: "settled",
            continuation: "closed",
            reason: "user_stop",
            settledAt: timestamp,
          },
          preRunCheckpointId: originId,
          unwoundAt: timestamp,
        }
        const selected = {
          id: interruptId,
          value: { ...request, interruptId: ids.firstInput, grant: token },
        }
        const changed =
          shape === "wrong-request"
            ? { ...selected, value: { ...selected.value, kind: "foreign" } }
            : shape === "wrong-token"
              ? { ...selected, value: { ...selected.value, grant: "forged" } }
              : selected
        const nativeValue =
          shape === "singleton"
            ? selected
            : shape === "duplicate-selected"
              ? [selected, selected]
              : shape === "duplicate-sibling"
                ? [{ id: "opaque", value: 0 }, selected, { id: "opaque", value: [] }]
                : shape === "nested-batch"
                  ? [[selected]]
                  : [
                      { id: "opaque-array", value: [null, 3, "opaque"] },
                      changed,
                      { id: "opaque-null", value: null },
                    ]
        const encoded = ["json", [...new TextEncoder().encode(JSON.stringify(nativeValue))]]
        const checkpoint = (
          id: string,
          ownerRunId: string | null,
          payload: unknown,
        ): RuntimeCheckpointRecord => ({
          state: { checkpoint: { checkpoint_id: id }, values: { retained: true } },
          namespace: [],
          ownerRunId,
          parentCheckpointId: null,
          payload,
          masked: false,
          lineage: [
            {
              threadId: ids.thread,
              generation: ids.generation,
              checkpointId: id,
              runId: ownerRunId,
              namespace: [],
              protectedMetadata: {},
            },
          ],
        })
        const origin = checkpoint(originId, ids.predecessor, {
          kind: "langgraph",
          v: 1,
          writes: [
            {
              kind: "execution",
              ownerRunId: shape === "wrong-owner" ? targetId : ids.predecessor,
              taskId: shape === "wrong-task" ? "foreign-task" : taskId,
              channel: "__interrupt__",
              namespaceGeneration: shape === "wrong-epoch" ? "foreign-epoch" : ids.predecessor,
              sourceCheckpointId: null,
              fence: 1,
              value: encoded,
            },
          ],
        })
        const safe = checkpoint(safeId, null, {
          safeHead: true,
          reboundFrom: {
            runId: ids.continuation,
            checkpointId: originId,
            checkpointOwnerRunId: ids.predecessor,
            stoppedSource: proof,
          },
        })
        const body: Omit<RuntimeProtectedSourceRecord, "digest"> = {
          v: 1,
          kind: "protected_source",
          aliasId: protectedSourceId(ids.thread, ids.generation, targetId),
          threadId: ids.thread,
          generation: ids.generation,
          runId: targetId,
          preRunCheckpointId: safeId,
          sourceRunId: ids.continuation,
          sourceCheckpointId: originId,
          checkpointOwnerRunId: ids.predecessor,
          stoppedSource: proof,
          sourceDigest: null,
          sourceRunIds: [ids.continuation],
          agents: ["/test#agent"],
        }
        const record = { ...body, digest: protectedSourceDigest(body) }
        try {
          await f.store.transaction(async (tx) => {
            await tx.thread.put({
              thread: {
                thread_id: ids.thread,
                created_at: timestamp,
                updated_at: timestamp,
                status: "idle",
                metadata: {},
              },
              generation: ids.generation,
              revision: 1,
              headCheckpointId: null,
              currentRunId: null,
              pausedGeneration: null,
              protectedMetadata: {},
            })
            await tx.runs.put({
              ...original,
              run: { ...original.run, status: "interrupted" },
              metadata: {
                ...original.metadata,
                phase: "settled",
                continuation: "closed",
                reason: "permission",
                settledAt: timestamp,
                startedAt: timestamp,
              },
              execution: { ownerId: "original-native-owner", fence: 1 },
              unwoundAt: timestamp,
            })
            await tx.checkpoints.put(origin)
            await tx.runs.put(source)
            await tx.checkpoints.put(safe)
            await tx.runs.put({ ...baseRun(targetId), preRunCheckpointId: safeId })
            await tx.pending.put(pending)
            await tx.grants.put({
              grantId: ids.firstGrant,
              tokenHash: sha256Hex(token),
              proposalHash,
              inputId: ids.firstInput,
              ownerRunId: ids.predecessor,
              namespace: [],
              pausedGeneration: ids.pausedGeneration,
              expiresAt: null,
              consumedByRunId: ids.continuation,
            })
            await tx.receipts.put({
              receiptId,
              fingerprint: sha256Hex("native-permission-operation"),
              state: "accepted",
              receipt: {
                submissionId: ids.submission,
                submissionKind: "b4",
                runId: ids.continuation,
                turnId: ids.predecessor,
                acceptedAt: timestamp,
                replayed: false,
                disposition: "accepted",
              },
              operation: {
                scopeKey: "canonical-native-source",
                method: "input.respond",
                operationThreadId: ids.thread,
                targetRunId: ids.predecessor,
                normalization: { messages: true, mechanicalDefaults: {}, configDefaults: {} },
                resolved: { permissionAgents: ["/test#agent"] },
                provenance: {},
                permissionBindings: [
                  {
                    v: 1,
                    ownerRunId: ids.predecessor,
                    pausedGeneration: ids.pausedGeneration,
                    namespace: [],
                    inputId: ids.firstInput,
                    proposalHash,
                    nativeBinding,
                    decision: "once",
                    grantId: ids.firstGrant,
                    grantMode: "required",
                  },
                ],
              },
            })
            const thread = await tx.thread.get()
            if (!thread) throw new Error("Missing seeded Thread")
            await tx.thread.put({ ...thread, headCheckpointId: safeId, currentRunId: targetId })
          })
          const before = await f.store.snapshot()
          if (shape === "singleton" || shape === "batch") {
            await f.store.transaction((tx) => tx.protectedSources.put(record))
            expect(
              await f.store.transaction((tx) => tx.protectedSources.get(record.aliasId)),
            ).toEqual(record)
            const aliases = await f.store.transaction((tx) => tx.protectedSources.list())
            await f.store.transaction((tx) => tx.protectedSources.put(record))
            expect(await f.store.transaction((tx) => tx.protectedSources.list())).toEqual(aliases)
          } else {
            await expect(
              f.store.transaction((tx) => tx.protectedSources.put(record)),
            ).rejects.toMatchObject({ code: "scope_mismatch" })
            expect(await f.store.transaction((tx) => tx.protectedSources.list())).toEqual([])
            expect(await f.store.snapshot()).toEqual(before)
          }
        } finally {
          await f.close()
        }
      },
      30_000,
    )
  })
}
