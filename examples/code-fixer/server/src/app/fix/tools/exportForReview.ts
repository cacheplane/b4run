import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { B4ToolContext } from "@b4run/sdk"
import { appRoot } from "../../../project/workspace.js"
import { type ReviewCandidate, validateCandidate } from "../../../review/candidate.js"
import { renderReviewDiff } from "../../../review/patch.js"
import { inspectCandidate } from "../../../review/prepare.js"
import { verifyChanges } from "../../../review/verifier.js"

/** Export the exact reviewed candidate locally after runtime approval. */
export default async function exportForReview(
  input: { candidate: ReviewCandidate },
  ctx: B4ToolContext,
) {
  const candidate = validateCandidate(input.candidate)
  const inspected = await inspectCandidate(ctx)
  if (candidate.receiptDigest !== inspected.candidate.receiptDigest)
    throw new Error("Workspace changed since review; prepare and approve a new candidate")
  const verification = await verifyChanges(
    inspected.manifest.id,
    candidate.changes,
    ctx.signal,
    inspected.initial,
  )
  if (!verification.passed) throw new Error("Independent verification failed")
  const outbox = join(appRoot, ".b4/code-fixer/review-outbox")
  await mkdir(outbox, { recursive: true })
  const filename = `${candidate.receiptDigest}.json`
  // The receipt is deterministic so retrying the same approved bytes is idempotent.
  const receipt = JSON.stringify(
    {
      task: inspected.manifest.id,
      candidate,
      diff: renderReviewDiff(inspected.baseline, candidate.changes),
    },
    null,
    2,
  )
  try {
    await writeFile(join(outbox, filename), receipt, { flag: "wx" })
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(join(outbox, filename), "utf8")) !== receipt
    )
      throw error
  }
  return {
    exported: true,
    task: inspected.manifest.id,
    file: filename,
    message: "Verified patch exported for local review.",
  }
}
