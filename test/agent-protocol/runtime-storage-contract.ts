/** Shared declarations for REAL SQLite/Postgres entrypoints (R2/R3). Importing
 * or typechecking this file does not run/certify either backend. No fake store,
 * alternate admission service, opt-out cases or skipped-provider fallback. */
import type {
  RuntimeGrantRecord,
  RuntimePendingRecord,
  RuntimeReceiptRecord,
  RuntimeRunRecord,
  RuntimeSnapshot,
  RuntimeStore,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { afterAll, describe, expect, it } from "vitest"

export const RUNTIME_STORAGE_CONTRACT_CASES = [
  "second grant failure rolls back both consumes",
  "awaited callback rejection rolls back both consumes",
  "commit exposes grants continuation and receipt together",
  "stale transaction fence rejects without mutation",
] as const

type ContractCase = (typeof RUNTIME_STORAGE_CONTRACT_CASES)[number]

export interface RuntimeStorageContractIds {
  readonly thread: string
  readonly generation: string
  readonly pausedGeneration: string
  readonly predecessor: string
  readonly continuation: string
  readonly firstGrant: string
  readonly secondGrant: string
  readonly firstInput: string
  readonly secondInput: string
  readonly submission: string
}

export interface RuntimeStorageContractFixture {
  /** Fresh, isolated actual backend, bound by the internal factory to validated
   * test authority. No process-global Maps or simulated commits. */
  readonly store: RuntimeStore
  /** Independent committed reader (SQLite WAL reader / separate PG connection),
   * under the same validated scope. Uses nonblocking MVCC/WAL reads, never the
   * writer Thread lock, and never shares uncommitted writer state. */
  readonly observer: Pick<RuntimeStore, "snapshot">
  /** Real durable ownership transition; return a freshly fenced binding while
   * retaining the old store so the suite can attempt a stale transaction. */
  advanceFence(): Promise<RuntimeStore>
  close(): Promise<void>
}

/** Only backend construction, deterministic IDs and clock are injected. The
 * suite writes storage records directly; business admission remains in R4/R6. */
export interface RuntimeStorageContractOptions {
  readonly createBackend: (options: {
    readonly ids: RuntimeStorageContractIds
    readonly now: () => string
  }) => Promise<RuntimeStorageContractFixture>
  readonly ids: RuntimeStorageContractIds
  readonly now: () => string
}

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function records(ids: RuntimeStorageContractIds, now: string) {
  const grant = (grantId: string, inputId: string): RuntimeGrantRecord => ({
    grantId,
    inputId,
    tokenHash: `hash:${grantId}`,
    proposalHash: `proposal:${inputId}`,
    ownerRunId: ids.predecessor,
    pausedGeneration: ids.pausedGeneration,
    namespace: [],
    expiresAt: null,
    consumedByRunId: null,
  })
  const continuation: RuntimeRunRecord = {
    run: {
      run_id: ids.continuation,
      thread_id: ids.thread,
      agent_id: "/test#agent",
      created_at: now,
      updated_at: now,
      status: "pending",
      metadata: {},
    },
    metadata: {
      v: 1,
      generation: ids.generation,
      turnId: ids.predecessor,
      previousRunId: ids.predecessor,
      phase: "accepted",
      continuation: "none",
      acceptedAt: now,
      effectsUncertain: false,
      submissionId: ids.submission,
      submissionKind: "b4",
    },
    namespace: [],
    preRunCheckpointId: null,
    result: null,
  }
  const predecessor: RuntimeRunRecord = {
    ...continuation,
    run: { ...continuation.run, run_id: ids.predecessor, status: "interrupted" },
    metadata: {
      v: 1,
      generation: ids.generation,
      turnId: ids.predecessor,
      phase: "settled",
      continuation: "waiting",
      acceptedAt: now,
      settledAt: now,
      reason: "permission",
      effectsUncertain: false,
    },
  }
  const pending = (inputId: string): RuntimePendingRecord => ({
    input: {
      namespace: [],
      runId: ids.predecessor,
      turnId: ids.predecessor,
      data: {
        interruptId: inputId,
        payload: {},
        b4: {
          v: 1,
          pausedGeneration: ids.pausedGeneration,
          proposalHash: `proposal:${inputId}`,
          status: "waiting",
        },
      },
    },
    ownerRunId: ids.predecessor,
    namespace: [],
    disposition: "pending",
    decision: null,
  })
  const receipt: RuntimeReceiptRecord = {
    receiptId: ids.submission,
    fingerprint: "fixed-protected-operation-fingerprint",
    state: "accepted",
    receipt: {
      submissionId: ids.submission,
      submissionKind: "b4",
      runId: ids.continuation,
      turnId: ids.predecessor,
      acceptedAt: now,
      replayed: false,
      disposition: "accepted",
    },
  }
  return {
    first: grant(ids.firstGrant, ids.firstInput),
    second: grant(ids.secondGrant, ids.secondInput),
    continuation,
    predecessor,
    firstPending: pending(ids.firstInput),
    secondPending: pending(ids.secondInput),
    receipt,
  }
}

async function consumeBoth(tx: RuntimeTransaction, ids: RuntimeStorageContractIds) {
  expect(await tx.grants.consume(ids.firstGrant, ids.continuation)).toBe(true)
  expect(await tx.grants.consume(ids.secondGrant, ids.continuation)).toBe(true)
}

function assertAbsent(snapshot: RuntimeSnapshot, ids: RuntimeStorageContractIds) {
  // Checking full records, rather than just counts, catches partial consumption.
  expect(snapshot.grants.find((row) => row.grantId === ids.firstGrant)?.consumedByRunId).toBe(null)
  expect(snapshot.grants.find((row) => row.grantId === ids.secondGrant)?.consumedByRunId).toBe(null)
  expect(snapshot.runs.find((row) => row.run.run_id === ids.continuation)).toBeUndefined()
  expect(snapshot.receipts.find((row) => row.receiptId === ids.submission)).toBeUndefined()
}

/** One registration runs EVERY assertion. There is no selectable case list or
 * support flag; a backend error fails instead of skipping. The completion check
 * also rejects accidental omission/skip when any suite case is executed. */
export function declareRuntimeStorageContract(options: RuntimeStorageContractOptions): void {
  describe("coordinated runtime storage contract", () => {
    const completed = new Set<ContractCase>()
    afterAll(() => {
      expect([...completed].sort()).toEqual([...RUNTIME_STORAGE_CONTRACT_CASES].sort())
    })
    for (const name of RUNTIME_STORAGE_CONTRACT_CASES) {
      it(name, async ({ signal: testSignal }) => {
        const { ids, now } = options
        const fixture = await options.createBackend({ ids, now })
        const data = records(ids, now())
        try {
          await fixture.store.transaction(async (tx) => {
            expect(tx.scope.threadId).toBe(ids.thread)
            expect(tx.scope.generation).toBe(ids.generation)
            await tx.thread.put({
              thread: {
                thread_id: ids.thread,
                created_at: now(),
                updated_at: now(),
                metadata: {},
                status: "interrupted",
              },
              generation: ids.generation,
              revision: 1,
              headCheckpointId: null,
              currentRunId: null,
              pausedGeneration: null,
              protectedMetadata: {},
            })
            await tx.runs.put(data.predecessor)
            await tx.pending.put(data.firstPending)
            await tx.pending.put(data.secondPending)
            const thread = await tx.thread.get()
            if (!thread) throw new Error("seed Thread disappeared inside transaction")
            await tx.thread.put({
              ...thread,
              currentRunId: ids.predecessor,
              pausedGeneration: ids.pausedGeneration,
            })
            await tx.grants.put(data.first)
            await tx.grants.put(data.second)
          })
          assertAbsent(await fixture.observer.snapshot(), ids)

          if (
            name === "second grant failure rolls back both consumes" ||
            name === "awaited callback rejection rolls back both consumes"
          ) {
            const injected = new Error("internal failure after second grant consume")
            await expect(
              fixture.store.transaction(async (tx) => {
                await consumeBoth(tx, ids)
                if (name === "awaited callback rejection rolls back both consumes") {
                  // This await MUST settle before the database wrapper may COMMIT.
                  await Promise.resolve()
                  await Promise.reject(injected)
                }
                throw injected
              }),
            ).rejects.toBe(injected)
            assertAbsent(await fixture.observer.snapshot(), ids)
          } else if (name === "commit exposes grants continuation and receipt together") {
            const staged = signal()
            const release = signal()
            // A broken lock-blocked reader must not retain the writer callback
            // after the test's existing deadline/cancellation. Do not raise it.
            testSignal.addEventListener("abort", release.resolve, { once: true })
            if (testSignal.aborted) release.resolve()
            const commit = fixture.store.transaction(async (tx) => {
              await consumeBoth(tx, ids)
              await tx.runs.put(data.continuation)
              await tx.receipts.put(data.receipt)
              staged.resolve()
              await release.promise
            })
            try {
              // Fail immediately if the transaction settles before its callback.
              await Promise.race([
                staged.promise,
                commit.then(() => {
                  throw new Error("transaction committed before callback settlement")
                }),
              ])
              assertAbsent(await fixture.observer.snapshot(), ids)
              testSignal.throwIfAborted()
            } finally {
              release.resolve()
              testSignal.removeEventListener("abort", release.resolve)
              await commit
            }
            const snapshot = await fixture.observer.snapshot()
            expect(
              snapshot.grants.find((row) => row.grantId === ids.firstGrant)?.consumedByRunId,
            ).toBe(ids.continuation)
            expect(
              snapshot.grants.find((row) => row.grantId === ids.secondGrant)?.consumedByRunId,
            ).toBe(ids.continuation)
            expect(snapshot.runs.find((row) => row.run.run_id === ids.continuation)).toEqual(
              data.continuation,
            )
            expect(snapshot.receipts.find((row) => row.receiptId === ids.submission)).toEqual(
              data.receipt,
            )
          } else {
            const oldScope = (await fixture.store.snapshot()).scope
            const current = await fixture.advanceFence()
            const before = await current.snapshot()
            expect(before.scope.generation).toBe(oldScope.generation)
            expect(before.scope.fence).toBeGreaterThan(oldScope.fence)
            // Persistence diagnostic only; C5 translates at public bindings.
            // This adds no REST/ASP wire error or B4 metadata key.
            await expect(
              fixture.store.transaction(async (tx) => {
                await consumeBoth(tx, ids)
                await tx.runs.put(data.continuation)
                await tx.receipts.put(data.receipt)
              }),
            ).rejects.toMatchObject({ code: "stale_fence" })
            assertAbsent(await current.snapshot(), ids)
          }
          completed.add(name)
        } finally {
          await fixture.close()
        }
      })
    }
  })
}
