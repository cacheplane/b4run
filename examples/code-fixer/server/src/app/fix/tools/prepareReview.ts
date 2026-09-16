import type { B4ToolContext } from "@b4run/sdk"
import { inspectCandidate } from "../../../review/inspect.js"
import { renderReviewDiff } from "../../../review/patch.js"
import { verifyChanges } from "../../../review/verifier.js"

/** Verify the source repair independently and return the exact candidate for review. */
export default async function prepareReview(_input: Record<string, never>, ctx: B4ToolContext) {
  // Compare the workspace with its captured source and reject edits outside the allowed files.
  const { manifest, candidate, baseline, initial } = await inspectCandidate(ctx)

  // Apply these exact changes in a fresh workspace and run both test suites.
  const verification = await verifyChanges(manifest.id, candidate.changes, ctx.signal, initial)
  if (!verification.passed) throw new Error("Independent verification failed")

  // Give the agent a readable diff and the exact candidate it must submit for approval.
  return {
    task: manifest.id,
    candidate,
    diff: renderReviewDiff(baseline, candidate.changes),
    verification,
  }
}
