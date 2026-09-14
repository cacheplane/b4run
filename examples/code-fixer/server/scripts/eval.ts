import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { runAttempt } from "../src/blueprint/run-attempt.js"

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    attempts: { type: "string", default: "3" },
    replay: { type: "boolean", default: false },
    output: { type: "string", default: "artifacts/code-fixer" },
  },
})
const attempts = Number(values.attempts)
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
  throw new Error("attempts must be 1–10 per fixture")
if (!values.replay && !process.env.OPENAI_API_KEY)
  throw new Error("OPENAI_API_KEY is required for live evaluation")
const output = resolve(values.output, `batch-${randomUUID()}`)
await mkdir(output, { recursive: true })
const summary: unknown[] = []
batch: for (const task of ["cli-flags", "nullable-inputs"]) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await runAttempt({
      task,
      mode: values.replay ? "replay" : "live",
      outputRoot: output,
    })
    summary.push({
      task,
      attempt,
      output: result.output,
      status: result.receipt.status,
      passed: result.receipt.passed,
      durationMs: result.receipt.durationMs,
      usage: result.receipt.usage,
    })
    await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2))
    console.log(`${task} ${attempt}/${attempts}: ${result.receipt.status}`)
    if (result.receipt.passed !== true) process.exitCode = 1
    if (["cancelled", "artifact-failed", "cleanup-failed"].includes(String(result.receipt.status)))
      break batch
    if (
      (result.receipt.usage as { reportedTokens?: number } | undefined)?.reportedTokens &&
      Number((result.receipt.usage as { reportedTokens: number }).reportedTokens) > 100_000
    )
      throw new Error("Reported token budget exceeded; batch halted")
  }
}
console.log(`Batch: ${output}`)
