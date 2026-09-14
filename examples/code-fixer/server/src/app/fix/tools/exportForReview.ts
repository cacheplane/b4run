import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { B4ToolContext } from "@b4run/sdk"
import { attemptContext } from "../../../blueprint/attempt-context.js"

export default async function exportForReview(_input: Record<string, never>, ctx: B4ToolContext) {
  const root = process.env.B4_CODE_FIXER_ATTEMPT_DIR
  if (!root) throw new Error("Run the agent through the blueprint runner to export")
  const receipt = await attemptContext().verify(ctx.signal)
  if (!receipt.verification.passed) throw new Error("Independent verification failed")
  const outbox = join(root, "review-outbox")
  await mkdir(outbox, { recursive: true })
  await writeFile(join(outbox, "patch.json"), JSON.stringify(receipt, null, 2), { flag: "wx" })
  return {
    exported: true,
    task: receipt.task,
    message: "Verified patch exported for local review. No remote publication.",
  }
}
