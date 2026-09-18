import { freezeBundle } from "../review/bundle.js"
import { AssemblyRejectedError, assembleCandidate } from "../verification/assemble.js"
import { loadPolicy } from "../verification/policy.js"
import type { ControllerContext } from "./context.js"

/**
 * The verifying phase. Everything here is the controller's own view: its captured
 * baseline, its assembly policy, its verifier and its bundle. Nothing reads a
 * claim made by the builder.
 *
 * Every exit is a recorded transition. A harness that cannot run is
 * `inconclusive`, not a failure, because "we do not know" and "it is broken" are
 * different answers and only one of them is about the candidate.
 */
export async function runVerification(ctx: ControllerContext, id: string): Promise<void> {
  const row = ctx.mustGet(id)
  if (row.state !== "verifying" || !row.workerThreadId) return
  const policy = loadPolicy(row.taskId)

  const baseline = await ctx.captureBaseline(row.taskId, ctx.signal)
  const observed = await ctx.workspaceReader.read(row.workerThreadId, ctx.signal)
  // Both reads were awaits: a cancel may have moved the row, and none of the moves
  // below is legal from where it left it.
  if (ctx.mustGet(id).state !== "verifying") return

  let candidate: ReturnType<typeof assembleCandidate>
  try {
    candidate = assembleCandidate({
      baseline: baseline.files,
      observed,
      policy: {
        workspaceId: row.taskId,
        baselineDigest: baseline.digest,
        allowedSourcePaths: policy.allowedSourcePaths,
        immutablePaths: policy.immutablePaths,
        maxChangedBytes: ctx.maxChangedBytes,
      },
    })
  } catch (error) {
    if (!(error instanceof AssemblyRejectedError)) throw error
    ctx.transition(
      id,
      "assembly_rejected",
      { blockedReason: error.rule === "removed" ? "baseline_mismatch" : "scope_violation" },
      { rule: error.rule, detail: error.message },
    )
    return
  }

  if (candidate.changedPaths.length === 0) {
    ctx.transition(
      id,
      "turn_ended_without_changes",
      { failureReason: "ended_without_candidate" },
      { reason: "the builder left the baseline unchanged" },
    )
    return
  }

  const artifact = await ctx.artifacts.put(JSON.stringify(candidate.changes, null, 2))
  ctx.store.transaction(() => {
    // One read inside the transaction, not one per use: the revision the row is stamped
    // against must be the one that was checked, and `recordCandidate` and `recordEvent`
    // do not move it. Re-reading is still necessary — the `row` above predates two awaits.
    const current = ctx.mustGet(id)
    if (current.state !== "verifying") return
    ctx.evidence.recordCandidate({
      digest: candidate.digest,
      workOrderId: id,
      baselineDigest: baseline.digest,
      changedPaths: [...candidate.changedPaths],
      bytes: candidate.bytes,
      artifactDigest: artifact.digest,
      assembledAt: ctx.iso(),
    })
    ctx.recordEvent(id, "candidate_assembled", {
      digest: candidate.digest,
      changedPaths: candidate.changedPaths,
      bytes: candidate.bytes,
    })
    ctx.store.update(id, current.revision, { candidateDigest: candidate.digest }, ctx.iso())
  })
  if (ctx.mustGet(id).state !== "verifying") return

  let receipt: Awaited<ReturnType<typeof ctx.verifier.verify>>
  try {
    receipt = await ctx.verifier.verify(
      {
        workOrderId: id,
        taskId: row.taskId,
        candidateDigest: candidate.digest,
        changes: candidate.changes,
        policyDigest: policy.policyDigest,
      },
      ctx.signal,
    )
  } catch (error) {
    ctx.recordEvent(id, "verifier_unavailable", { error: String(error) })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  if (receipt.candidateDigest !== candidate.digest) {
    ctx.recordEvent(id, "receipt_mismatch", {
      expected: candidate.digest,
      got: receipt.candidateDigest,
    })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  ctx.evidence.recordReceipt(receipt)
  ctx.recordEvent(id, "receipt_issued", {
    id: receipt.id,
    verdict: receipt.verdict,
    verifierIdentity: receipt.verifierIdentity,
  })

  if (ctx.mustGet(id).state !== "verifying") return
  if (receipt.verdict === "fail") {
    ctx.transition(id, "receipt_failed", { blockedReason: "verification_failed" })
    return
  }
  if (receipt.verdict === "inconclusive") {
    ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  const bundle = freezeBundle({
    workOrderId: id,
    repositoryId: row.taskId,
    baselineDigest: baseline.digest,
    specificationDigest: policy.specificationDigest,
    policyDigest: policy.policyDigest,
    candidateDigest: candidate.digest,
    receipt,
    destinationId: ctx.exportDir,
    frozenAt: ctx.iso(),
  })

  ctx.store.transaction(() => {
    ctx.evidence.recordBundle(bundle)
    ctx.recordEvent(id, "bundle_frozen", { digest: bundle.digest, receiptId: receipt.id })
    ctx.transition(id, "receipt_passed", {
      bundleDigest: bundle.digest,
      awaitingSince: ctx.iso(),
    })
  })
}
