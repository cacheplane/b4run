import type { WorkOrderRow } from "../domain/work-order.js"
import { oracleReceiptIdFor } from "../intake/oracle.js"
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
  const signal = ctx.verificationSignal(id)
  try {
    await verifyCandidate(ctx, id, row, signal)
  } catch (error) {
    // The backstop. The specific faults below (`baseline_unavailable`, `workspace_unreadable`,
    // `verifier_unavailable`) each journal what they know and return; this catches everything
    // else — a failed artifact write, a policy that will not load, a registry constraint, a
    // bug. Without it the throw escapes into `track()`, which records `run_observer_error`
    // and leaves the row in `verifying` with no transition: recoverable only by a restart,
    // and in-process a hang. Whatever the fault was, the controller does not know anything
    // about the candidate, which is what `inconclusive` means.
    ctx.recordEvent(id, "verification_phase_error", { error: String(error) })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
  }
}

async function verifyCandidate(
  ctx: ControllerContext,
  id: string,
  row: WorkOrderRow,
  signal: AbortSignal,
): Promise<void> {
  const threadId = row.workerThreadId as string
  const policy = loadPolicy(row.taskId)

  /**
   * A read the controller could not make is not a verdict about the candidate: it is the
   * controller admitting it does not know. Recorded as `inconclusive`, like a harness that
   * could not run, rather than escaping the phase and leaving the row in `verifying` with
   * nothing journalled to say why.
   */
  const unreadable = (type: string, error: unknown): void => {
    // Aborted reads are the controller's own doing (the row left `verifying`, or the factory
    // is closing), not a baseline or workspace it could not reach.
    if (signal.aborted) {
      ctx.recordEvent(id, "verification_aborted", { reason: String(signal.reason) })
      return
    }
    ctx.recordEvent(id, type, { error: String(error) })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
  }

  let baseline: Awaited<ReturnType<typeof ctx.captureBaseline>>
  try {
    baseline = await ctx.captureBaseline(row.taskId, signal)
  } catch (error) {
    unreadable("baseline_unavailable", error)
    return
  }
  let observed: ReadonlyMap<string, string>
  try {
    // The target's builder holds the thread; a target with no worker any more is a read
    // the controller cannot make, which is what `inconclusive` means.
    observed = await ctx.workerFor(row).reader.read({ threadId, taskId: row.taskId }, signal)
  } catch (error) {
    unreadable("workspace_unreadable", error)
    return
  }
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
    // `encoding` is the one rule that is not about scope: the path was allowed and the
    // content is what the controller cannot represent. Every other rule — inventory,
    // immutable, added, removed, cap — is the builder writing where it may not, which is
    // what the spec's invariant table calls a `scope_violation`. Nothing here can be a
    // baseline mismatch: the controller diffs against its own captured baseline and never
    // reads a source digest the builder claims.
    // `elided` and `shrunk` are neither: the path was allowed and the bytes representable,
    // but the file is not whole, which `candidate_rejected` says in the journal's own words.
    const blockedReason =
      error.rule === "encoding"
        ? "encoding_violation"
        : error.rule === "elided" || error.rule === "shrunk"
          ? "candidate_rejected"
          : "scope_violation"
    ctx.transition(
      id,
      "assembly_rejected",
      { blockedReason },
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
      signal,
    )
  } catch (error) {
    // An abort is the controller's own doing — the row left `verifying` under it, or the
    // factory is closing — not a harness that could not run, and the row has already been
    // moved by whoever aborted it.
    if (signal.aborted) {
      ctx.recordEvent(id, "verification_aborted", { reason: String(signal.reason) })
      return
    }
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

  // One unit, as for the candidate and the bundle: a receipt row with no journal line
  // would leave reconciliation guessing which of the two is the truth.
  ctx.store.transaction(() => {
    ctx.evidence.recordReceipt(receipt)
    ctx.recordEvent(id, "receipt_issued", {
      id: receipt.id,
      verdict: receipt.verdict,
      verifierIdentity: receipt.verifierIdentity,
    })
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
    origin: row.origin,
    pin: row.pin,
    taskDigest: row.taskDigest,
    oracleReceiptId: oracleReceiptIdFor(ctx.store.events(id), row.taskDigest),
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
