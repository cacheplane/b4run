import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { createAgentHarness } from "@b4run/testing"
import { attemptContext } from "../src/blueprint/attempt-context.js"
import { behaviorCriteria, evaluateRun } from "../src/blueprint/evaluate.js"
import { redactEvidence, verdict } from "../src/blueprint/evidence.js"
import { fixturesRoot, loadManifest } from "../src/blueprint/fixture-catalog.js"
import { replayFixture, taskInput } from "../src/blueprint/replay.js"
import { sandboxImage } from "../src/blueprint/verifier.js"

const appRoot = fileURLToPath(new URL("../", import.meta.url))
const output = process.env.B4_CODE_FIXER_ATTEMPT_DIR
if (!output) throw new Error("Attempt output is required")
const live = process.env.B4_CODE_FIXER_MODE === "live"
const context = attemptContext()
const started = performance.now()
let harness: Awaited<ReturnType<typeof createAgentHarness>> | undefined
let receipt: Record<string, unknown> = { passed: false, status: "infrastructure-failed" }
try {
  if (live && !process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required for live runs")
  const manifest = await loadManifest(context.task)
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .update(await readFile(join(fixturesRoot, context.task, "task.md")))
  for (const path of [...manifest.allowedSourcePaths, ...manifest.immutablePaths].sort())
    digest.update(path).update(await readFile(join(fixturesRoot, context.task, "project", path)))
  const image = execFileSync("docker", ["image", "inspect", sandboxImage, "--format", "{{.Id}}"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim()
  let commit: string | null = null
  let dirty = true
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    dirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 10_000,
      }).trim().length > 0
  } catch {
    /* Standalone copies have source snapshots, but no clean commit provenance. */
  }
  harness = await createAgentHarness({ appRoot, route: "/fix#agent", live })
  const runStarted = performance.now()
  const run = await harness.run({
    input: taskInput,
    ...(!live ? { fixtures: await replayFixture(context.task) } : {}),
  })
  const runMs = Math.round(performance.now() - runStarted)
  receipt = {
    schemaVersion: 1,
    mode: live ? "live" : "replay",
    task: context.task,
    passed: false,
    status: "infrastructure-failed",
    run,
    timings: { runMs },
  }
  const source: Record<string, string> = {}
  for (const path of [
    "b4.config.ts",
    "src/app/fix/index.ts",
    "src/app/fix/plan.md",
    "src/app/fix/skills/verify-change/SKILL.md",
    "src/app/fix/tools/exportForReview.ts",
  ])
    source[path] = await readFile(join(appRoot, path), "utf8")
  digest.update(await readFile(join(fixturesRoot, context.task, "checks/independent.test.ts")))
  const verifyStarted = performance.now()
  const prepared = await context.verify(AbortSignal.timeout(120_000))
  const verificationMs = Math.round(performance.now() - verifyStarted)
  const criteria = {
    visible: prepared.verification.visible.passed,
    independent: prepared.verification.independent.passed,
    scope: true,
    ...behaviorCriteria(run),
  }
  receipt = {
    schemaVersion: 1,
    mode: live ? "live" : "replay",
    task: context.task,
    agent: {
      commit,
      dirty,
      model: process.env.B4_CODE_FIXER_MODEL ?? "gpt-5-mini",
      recursionLimit: 60,
    },
    fixture: { manifest, sha256: digest.digest("hex") },
    image,
    source,
    ...verdict(criteria, run.interrupts.length > 0),
    criteria,
    evaluation: await evaluateRun(run, criteria),
    prepared,
    run,
    timings: { runMs, verificationMs },
    usage: {
      reportedTokens: null,
      reason: "Public harness results do not expose authoritative billable usage.",
    },
  }
  if (process.env.B4_CODE_FIXER_INTERACTIVE === "1" && receipt.passed === true) {
    process.stderr.write(`\n${prepared.diff}\nVisible and independent checks passed.\n`)
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    let approved = false
    try {
      approved =
        (await prompt.question("Export this independently verified patch for local review? [y/N] "))
          .trim()
          .toLowerCase() === "y"
    } finally {
      prompt.close()
    }
    const resumed = await harness.resume({
      resume: run.interrupts.map((entry) => ({
        interruptId: entry.interruptId,
        status: "resolved" as const,
        payload: approved ? "once" : "deny",
      })),
    })
    receipt.approval = approved ? "approved" : "denied"
    receipt.resumed = resumed
    receipt.status = approved ? "passed" : "approval-denied"
    if (approved)
      receipt.exported = JSON.parse(
        await readFile(join(output, "review-outbox/patch.json"), "utf8"),
      )
  }
} catch (error) {
  receipt.passed = false
  if (error instanceof Error && error.name === "PatchRejectedError")
    receipt.status = "behavior-failed"
  if (receipt.status === "passed" || receipt.status === "approval-pending")
    receipt.status = "infrastructure-failed"
  receipt.error = error instanceof Error ? error.message : String(error)
} finally {
  try {
    await harness?.close()
  } catch (error) {
    receipt.closeError = String(error)
    receipt.passed = false
    receipt.status = "cleanup-failed"
  }
  try {
    await context.provider.destroyAll()
  } catch (error) {
    receipt.cleanupError = String(error)
    receipt.passed = false
    receipt.status = "cleanup-failed"
  }
  receipt.durationMs = Math.round(performance.now() - started)
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name) && value && value.length > 5)
    .map(([, value]) => value as string)
  await writeFile(
    join(output, "worker-result.json"),
    JSON.stringify(redactEvidence(receipt, secrets, [appRoot, process.env.HOME ?? ""]), null, 2),
    { flag: "wx" },
  )
}
