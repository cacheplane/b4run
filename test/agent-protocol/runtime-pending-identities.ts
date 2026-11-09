import type {
  RuntimeGrantRecord,
  RuntimePendingRecord,
  RuntimeRunRecord,
  RuntimeStore,
  RuntimeThreadRecord,
} from "@b4run/sdk/agent-protocol"
import { expect } from "vitest"

/** Extra actual-backend regression; the original four conformance cases stay intact. */
export async function assertPendingGrantIdentities(
  store: RuntimeStore,
  run: RuntimeRunRecord,
  thread: RuntimeThreadRecord,
): Promise<void> {
  const owner = run.run.run_id,
    otherOwner = crypto.randomUUID(),
    continuation = crypto.randomUUID()
  const base: RuntimeGrantRecord = {
    grantId: "current-root",
    tokenHash: "hash",
    proposalHash: "current-proposal",
    inputId: "same-public-input",
    ownerRunId: owner,
    pausedGeneration: "current-pause",
    namespace: [],
    expiresAt: null,
    consumedByRunId: null,
  }
  const grants: RuntimeGrantRecord[] = [
    base,
    {
      ...base,
      grantId: "current-child",
      namespace: [
        "delegate",
        Array.from({ length: 512 }, () => crypto.randomUUID()).join(""),
        'child,[]"',
      ],
      proposalHash: "child-proposal",
    },
    { ...base, grantId: "separated-a", namespace: ["a", "bc"] },
    { ...base, grantId: "separated-b", namespace: ["ab", "c"] },
    {
      ...base,
      grantId: "historical",
      pausedGeneration: "old-pause",
      consumedByRunId: continuation,
    },
    { ...base, grantId: "other-owner", ownerRunId: otherOwner },
    { ...base, grantId: "other-pause", pausedGeneration: "other-pause" },
    { ...base, grantId: "other-proposal", proposalHash: "other-proposal" },
  ]
  const pending: RuntimePendingRecord[] = grants.map((grant, i) => ({
    ownerRunId: grant.ownerRunId,
    namespace: grant.namespace,
    disposition: i < 4 ? "pending" : "retired",
    decision: null,
    input: {
      namespace: grant.namespace,
      runId: grant.ownerRunId,
      turnId: owner,
      data: {
        interruptId: grant.inputId,
        payload: {},
        b4: {
          v: 1,
          pausedGeneration: grant.pausedGeneration,
          proposalHash: grant.proposalHash,
          status: "waiting",
        },
      },
    },
  }))
  await store.transaction(async (tx) => {
    await tx.runs.put(run)
    for (const id of [otherOwner, continuation])
      await tx.runs.put({ ...run, run: { ...run.run, run_id: id } })
    await tx.thread.put({
      ...thread,
      headCheckpointId: null,
      currentRunId: owner,
      pausedGeneration: base.pausedGeneration,
    })
    for (const row of pending) await tx.pending.put(row)
    for (const grant of grants) await tx.grants.put(grant)
  })
  expect((await store.snapshot()).pending).toHaveLength(8)
  await store.transaction(async (tx) => {
    for (const [i, grant] of grants.entries())
      expect(await tx.pending.get(grant)).toEqual(pending[i])
    for (const grant of grants.slice(4))
      expect(await tx.grants.consume(grant.grantId, continuation)).toBe(false)
    expect(await tx.grants.consume(base.grantId, continuation)).toBe(true)
    expect(await tx.grants.consume("current-child", continuation)).toBe(true)
    expect(await tx.grants.consume("separated-a", continuation)).toBe(true)
    expect(await tx.grants.consume("separated-b", continuation)).toBe(true)
  })
  const after = await store.snapshot()
  expect(after.pending).toHaveLength(8)
  expect(after.grants).toHaveLength(8)
  for (const grant of grants)
    expect(after.grants.find((g) => g.grantId === grant.grantId)).toEqual(
      ["current-root", "current-child", "separated-a", "separated-b"].includes(grant.grantId)
        ? { ...grant, consumedByRunId: continuation }
        : grant,
    )
}
