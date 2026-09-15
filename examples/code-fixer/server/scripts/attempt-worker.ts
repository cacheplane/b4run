import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { type AgentRunResult, createAgentHarness, script } from "@b4run/testing"
import { behaviorCriteria, evaluateRun } from "../src/evaluation/evaluate.js"
import { failureStatus, redactEvidence, verdict } from "../src/evaluation/evidence.js"
import { replayFixture, taskInput } from "../src/evaluation/replay.js"
import { fixturesRoot, loadManifest } from "../src/fixtures/catalog.js"
import type { prepareReview } from "../src/review/prepare.js"
import { sandboxImage } from "../src/review/verifier.js"

const appRoot = process.env.B4_CODE_FIXER_APP_ROOT
if (!appRoot) throw new Error("Evaluation app installation is required")
const output = process.env.B4_CODE_FIXER_ATTEMPT_DIR
if (!output) throw new Error("Attempt output is required")
const live = process.env.B4_CODE_FIXER_MODE === "live"
const task = process.env.B4_CODE_FIXER_TASK ?? "cli-flags"
const started = performance.now()
let harness: Awaited<ReturnType<typeof createAgentHarness>> | undefined
let receipt: Record<string, unknown> = { passed: false, status: "infrastructure-failed" }
try {
  if (live && !process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required for live runs")
  const manifest = await loadManifest(task)
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .update(await readFile(join(fixturesRoot, task, "task.md")))
  for (const path of [...manifest.allowedSourcePaths, ...manifest.immutablePaths].sort())
    digest.update(path).update(await readFile(join(fixturesRoot, task, "project", path)))
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
  let run = await harness.run({
    input: taskInput,
    ...(!live ? { fixtures: await replayFixture(task) } : {}),
  })
  const runMs = Math.round(performance.now() - runStarted)
  receipt = {
    schemaVersion: 1,
    mode: live ? "live" : "replay",
    task: task,
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
  digest.update(await readFile(join(fixturesRoot, task, "checks/independent.test.ts")))
  const preparation = [...run.toolResults]
    .reverse()
    .find((entry) => entry.name === "prepareReview" && !entry.isError)
  if (!preparation) throw new Error("Agent did not prepare an independently verified candidate")
  const prepared = (
    typeof preparation.content === "string" ? JSON.parse(preparation.content) : preparation.content
  ) as Awaited<ReturnType<typeof prepareReview>>
  const verificationMs = 0 // Independent checks are included in the route tool's run time.
  if (!live) {
    const input = "Request approval to export the prepared candidate."
    const approval = await harness.run({
      input,
      fixtures: script()
        .user(input)
        .callsTool("exportForReview", { candidate: prepared.candidate })
        .replies("Verified candidate exported for local review."),
    })
    run = {
      ...approval,
      toolCalls: [...run.toolCalls, ...approval.toolCalls],
      toolResults: [...run.toolResults, ...approval.toolResults],
    } as AgentRunResult
  }
  const criteria = {
    visible: prepared.verification.visible.passed,
    independent: prepared.verification.independent.passed,
    scope: true,
    ...behaviorCriteria(run),
  }
  receipt = {
    schemaVersion: 1,
    mode: live ? "live" : "replay",
    task: task,
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
    prepared: { ...prepared, changes: prepared.candidate.changes },
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
        await readFile(
          join(appRoot, ".b4/code-fixer/review-outbox", `${prepared.candidate.receiptDigest}.json`),
          "utf8",
        ),
      )
  }
} catch (error) {
  receipt.passed = false
  receipt.status = failureStatus(error)
  receipt.error = error instanceof Error ? error.message : String(error)
} finally {
  try {
    await harness?.close({ destroyWorkspaces: true })
  } catch (error) {
    receipt.closeError = String(error)
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
