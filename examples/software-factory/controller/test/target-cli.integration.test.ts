import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerSandbox } from "@b4run/sandbox"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { Receipt } from "../src/lib/domain/work-order.ts"
import type { ArtifactStore } from "../src/lib/storage/artifacts.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { ensurePin, loadTask, repositoryRoot, type Task } from "../src/lib/targets/catalog.ts"
import { imageTag } from "../src/lib/targets/images.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { gradeSuite } from "../src/lib/verification/grade-suite.ts"
import { loadPolicy } from "../src/lib/verification/policy.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * Layer 2 for the `cli` target at the #714 replay pin (765e6e16, the parent of the fix
 * b090ad42): the prepared image builds `@b4run/cli` and its nine workspace dependencies
 * offline and runs the scoped suite, and the grading harness discriminates. The shipped task's
 * independent check (a node:test port of the fix's reference test) fails at the pin and passes
 * with the reference fix; and the reference test ITSELF, the vitest file b090ad42 shipped, run
 * through the verifier's own session machinery beside the scoped suite, fails at the pin and
 * passes with the fix. That last pair is what grades the live run's candidate (plan, Task 4).
 */
const TASK = "cli-runs-wait-undefined"
const FIX = "b090ad42ffbf063d2540a80454ee480d1a0ebbf4"
const REFERENCE_TEST = "packages/cli/test/runs-wait-output.test.ts"
/**
 * Opt-in (`FACTORY_TEST_CLI_TARGET=1`, or `pnpm test:sandbox:cli`): the lane needs the `cli`
 * image prepared on this host (2 GB), and runs about 90 seconds for its six verifier
 * sessions. It ran about 70 minutes while every snapshot operation re-verified the whole
 * source bundle (#826), and 26 minutes while each snapshot made one `docker exec` per entry
 * (#827). The CI `sandbox-docker` job does not prepare the image.
 */
const ENABLED = process.env.FACTORY_TEST_CLI_TARGET === "1"
/** Stated rather than read from the target, so an unprepared checkout skips at collection. */
const DEADLINE_SLACK_MS = 3_600_000 + 60_000

/** Resolved inside the gated block: loading the task needs the prepared image and the pin. */
let task: Task
let policy: ReturnType<typeof loadPolicy>
let allowed: string
let budget: number

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const verify = async (changes: Record<string, string>, id: string) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-cli-"))
  dirs.push(dir)
  const artifacts = createArtifactStore(join(dir, "artifacts"))
  const receipt = await createDockerVerifier(artifacts, { stagingRoot: dir }).verify(
    {
      workOrderId: id,
      taskId: TASK,
      candidateDigest: "a".repeat(64),
      changes,
      policyDigest: policy.policyDigest,
    },
    // The target's own deadline plus slack, so the verifier reports its own timeout.
    AbortSignal.timeout(budget + 30_000),
  )
  return { receipt, artifacts }
}

const summary = (receipt: Receipt) => receipt.checks.map((c) => `${c.id}:${c.verdict}`)

const evidenceOf = async (artifacts: ArtifactStore, receipt: Receipt, checkId: string) => {
  const check = receipt.checks.find((c) => c.id === checkId)
  expect(check, `the receipt carries a ${checkId} check`).toBeDefined()
  return await artifacts.read(check?.evidence[0]?.digest as string)
}

/** The reference test as the fix shipped it, read from the repository's object store. */
function referenceTest(): string {
  const repo = repositoryRoot()
  ensurePin(repo, "cli", FIX, { label: "The cli target's reference test" })
  return execFileSync("git", ["-C", repo, "show", `${FIX}:${REFERENCE_TEST}`], {
    encoding: "utf8",
  })
}

/**
 * The task with the reference test appended to the target's visible command, graded in one
 * verifier session (capture, build, snapshot, vitest JSON report, tamper comparison): the same
 * machinery that grades a candidate, pointed at the one file the scoped suite leaves out.
 */
function withReferenceTest(base: Task): Task {
  const commands = {
    ...base.target.commands,
    test: [...base.target.commands.test, REFERENCE_TEST.replace(/^packages\/cli\//, "")],
  }
  return { ...base, target: { ...base.target, commands } }
}

const REFERENCE_CASES = [
  "answers 200 with JSON null when the route returns nothing",
  "leaves that response a success for B4's own runs/wait client",
  "agrees with runs/stream about a route that returns nothing",
  "does not flatten falsy outputs into null",
  "names the route when the output cannot be serialized",
  "still carries an ordinary object output unchanged",
].map((name) => `runs/wait output serialization ${name}`)
/** The cases the fix changed; the other two pass on either side of it. */
const FIXED_CASES = [0, 1, 2, 4].map((i) => REFERENCE_CASES[i] as string)

const gradeWithReferenceTest = async (changes: Record<string, string>) => {
  const stagingRoot = await mkdtemp(join(tmpdir(), "factory-cli-grade-"))
  dirs.push(stagingRoot)
  return gradeSuite({
    task: withReferenceTest(task),
    kind: "visible",
    changes: { [REFERENCE_TEST]: referenceTest(), ...changes },
    provider: dockerSandbox({ scope: "software-factory-verifier", image: imageTag(task.target) }),
    signal: AbortSignal.timeout(budget),
    stagingRoot,
  })
}

describe.skipIf(!ENABLED)("the cli target in its prepared image", () => {
  beforeAll(() => {
    task = loadTask(TASK)
    policy = loadPolicy(TASK)
    allowed = task.manifest.allowedSourcePaths[0] as string
    budget = task.target.resources.verifierDeadlineMs
    // The per-case timeouts below are fixed at collection, before the task loads.
    expect(budget + 60_000).toBeLessThanOrEqual(DEADLINE_SLACK_MS)
  })

  it(
    "builds, runs the scoped suite and admits the task: the reference repair passes both suites",
    async () => {
      const { receipt } = await verify({ [allowed]: await applyReference(TASK) }, "wo-ref")
      expect(summary(receipt)).toEqual(["visible:pass", "independent:pass"])
      expect(receipt.verdict).toBe("pass")
      expect(receipt.environmentIdentity).toBe(policy.environment.identity)
    },
    DEADLINE_SLACK_MS,
  )

  it(
    "passes the scoped suite at the pin and fails the independent check there",
    async () => {
      // No changes: the candidate IS the pin. The scoped suite does not contain the defect's
      // test, so it passes; the independent check is what sees #714.
      const { receipt, artifacts } = await verify({}, "wo-pin")
      expect(summary(receipt)).toEqual(["visible:pass", "independent:fail"])
      expect(receipt.verdict).toBe("fail")
      const independentOutput = await evidenceOf(artifacts, receipt, "independent")
      // The fix changed A1, A2, A3 and A5; A4 (falsy outputs) and A6 (an ordinary object)
      // pass on both sides of it.
      for (const failed of ["A1", "A2", "A3", "A5"])
        expect(independentOutput).toContain(`${failed} failed`)
      for (const held of ["A4", "A6"]) expect(independentOutput).not.toContain(`${held} failed`)
    },
    DEADLINE_SLACK_MS,
  )

  it(
    "fails the reference test at the pin, beside a passing scoped suite",
    async () => {
      const session = await gradeWithReferenceTest({})
      expect(session.build.ok).toBe(true)
      expect(session.tampered).toBe(false)
      expect(session.result?.verdict).toBe("fail")
      const events = session.result?.events ?? []
      const failed = events.filter((e) => e.type === "test:fail").map((e) => e.name)
      expect(failed.sort()).toEqual([...FIXED_CASES].sort())
      // The scoped suite ran in the same session and passed: well over a hundred tests.
      expect(events.filter((e) => e.type === "test:pass").length).toBeGreaterThan(100)
    },
    DEADLINE_SLACK_MS,
  )

  it(
    "passes the reference test with the reference fix, and the scoped suite still passes",
    async () => {
      const session = await gradeWithReferenceTest({ [allowed]: await applyReference(TASK) })
      expect(session.build.ok).toBe(true)
      expect(session.tampered).toBe(false)
      expect(session.result?.verdict).toBe("pass")
      const events = session.result?.events ?? []
      for (const name of REFERENCE_CASES)
        expect(events.filter((e) => e.type === "test:pass" && e.name === name)).toHaveLength(1)
      // The scoped suite ran in the same session: more passing tests than the reference six.
      expect(events.filter((e) => e.type === "test:pass").length).toBeGreaterThan(100)
      expect(events.some((e) => e.type === "test:fail")).toBe(false)
    },
    DEADLINE_SLACK_MS,
  )
})
