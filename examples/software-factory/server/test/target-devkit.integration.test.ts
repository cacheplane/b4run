import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Receipt } from "../src/domain/work-order.ts"
import type { ArtifactStore } from "../src/storage/artifacts.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { loadTask } from "../src/targets/catalog.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"
import { loadPolicy } from "../src/verification/policy.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * Layer 2 for the monorepo target: the prepared image really builds and tests the pinned
 * package, the visible regression test really fails on the defect-patched baseline, and the
 * task is admitted: its independent check fails on the defect and passes on the reference.
 */
const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const policy = loadPolicy(TASK)
const allowed = task.manifest.allowedSourcePaths[0] as string
const budget = task.target.resources.verifierDeadlineMs

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const verify = async (changes: Record<string, string>, id: string) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-devkit-"))
  dirs.push(dir)
  const artifacts = createArtifactStore(join(dir, "artifacts"))
  const receipt = await createDockerVerifier(artifacts).verify(
    {
      workOrderId: id,
      taskId: TASK,
      candidateDigest: "a".repeat(64),
      changes,
      policyDigest: policy.policyDigest,
    },
    // The target's own deadline plus slack: the verifier must report its own timeout as a
    // receipt, so the caller's signal firing first would hide the answer this lane wants.
    AbortSignal.timeout(budget + 30_000),
  )
  return { receipt, artifacts }
}

const summary = (receipt: Receipt) => receipt.checks.map((c) => `${c.id}:${c.verdict}`)

/** One check's stored output, read back through the store that hashes it. */
const evidenceOf = async (artifacts: ArtifactStore, receipt: Receipt, checkId: string) => {
  const check = receipt.checks.find((c) => c.id === checkId)
  expect(check, `the receipt carries a ${checkId} check`).toBeDefined()
  return await artifacts.read(check?.evidence[0]?.digest as string)
}

describe("the devkit target in its prepared image", () => {
  it(
    "builds, tests and admits the task: the reference repair passes both suites",
    async () => {
      const { receipt } = await verify({ [allowed]: await applyReference(TASK) }, "wo-ref")
      expect(summary(receipt)).toEqual(["visible:pass", "independent:pass"])
      expect(receipt.verdict).toBe("pass")
      expect(receipt.environmentIdentity).toBe(policy.environment.identity)
      expect(receipt.verifierIdentity).toBe(`docker:${policy.environment.identity}`)
    },
    budget + 60_000,
  )

  it(
    "fails the defect-patched baseline on the visible regression test and the independent check",
    async () => {
      // No changes: the candidate IS the baseline with the defect. Both oracles must see it.
      // `verify` is called directly here, so writing nothing is a legitimate way to grade the
      // baseline itself; the controller's assembly rejects a candidate that changed nothing
      // long before the verifier is reached, which is not this lane's concern.
      const { receipt, artifacts } = await verify({}, "wo-defect")
      expect(summary(receipt)).toEqual(["visible:fail", "independent:fail"])
      expect(receipt.verdict).toBe("fail")
      // The visible evidence names the regression test; the independent evidence names A1.
      expect(await evidenceOf(artifacts, receipt, "visible")).toContain(
        "clears the deadline when spawning fails asynchronously",
      )
      // The independent check prints its own diagnosis before asserting, because an
      // assertion's message never reaches the receipt: the evidence carries that line.
      const independentOutput = await evidenceOf(artifacts, receipt, "independent")
      expect(independentOutput).toContain("A1 failed")
    },
    budget + 60_000,
  )

  it(
    "grades a candidate that does not compile as a failed build, not inconclusive",
    async () => {
      const { receipt, artifacts } = await verify(
        { [allowed]: "export const broken: number = 'no'\n" },
        "wo-build",
      )
      expect(receipt.verdict).toBe("fail")
      expect(summary(receipt)).toEqual(["build:fail"])
      expect(await evidenceOf(artifacts, receipt, "build")).toMatch(/error TS|TS\d{4}/)
    },
    budget + 60_000,
  )
})
