import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Receipt } from "../src/lib/domain/work-order.ts"
import type { ArtifactStore } from "../src/lib/storage/artifacts.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { loadPolicy } from "../src/lib/verification/policy.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * Layer 3, adversarial: a candidate that tries to grade itself.
 *
 * The independent oracle for this task runs the BUILT artifact
 * (`packages/devkit/dist/testing/index.js`). A candidate's source is imported by the visible
 * vitest suite, so module-level code in it runs inside the verifier's container and can leave
 * a detached process behind — `--init` reaps zombies, not live detached children. That process
 * can overwrite the built artifact, so the builder would choose the bytes its own oracle reads.
 *
 * Two independent properties are asserted here, because the verifier now defends with two
 * different mechanisms:
 *
 * - **Isolation.** Each suite is graded in its own container, built from its own capture. The
 *   oracle therefore runs where the visible suite's test code never ran, and nothing that
 *   session left behind exists by then. That is the first test. Candidate code does still run
 *   in the second container — the check imports the built artifact, which re-exports the
 *   candidate's source — and that is what the second container's own snapshots bound.
 * - **Detection.** Within one session the workspace is still snapshotted before and after the
 *   suite, and any persistent change is a rejection. That is the second test, and it is also
 *   what keeps the first from being vacuous: the same spawn-a-detached-writer primitive, armed
 *   inside the graded window instead of after it, really does write and really is caught.
 *
 * Of the two directions this primitive has, the payloads here exercise the self-sabotaging
 * one: they install an artifact that FAILS the independent check. The dangerous mirror image —
 * a defective source whose writer installs a correct artifact and forges a pass — is described
 * in prose in the spec's risks. Exercising one direction is enough for both properties. The
 * tamper comparison is verdict-blind (it asserts only that the workspace after a suite equals
 * the workspace before it), and isolation is verdict-blind too (the container is gone either
 * way), so neither can tell the two directions apart and a proof for either is a proof for
 * both. Sabotage is the direction a test can assert cheaply, since an unmodified independent
 * check already distinguishes the stub from the real artifact.
 */
const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const policy = loadPolicy(TASK)
const allowed = task.manifest.allowedSourcePaths[0] as string
const budget = task.target.resources.verifierDeadlineMs

/**
 * How long the isolation payload's detached writer waits before it starts rewriting the built
 * artifact, measured from its own start — which is when the visible suite imports the
 * candidate's module.
 *
 * This one is a clock and not a workspace event, unlike {@link WRITE_FOR_MS}'s companion
 * below, because there is no workspace event to take a cue from any more: the independent
 * check file that the old payload waited for is now written in a different container, which
 * this process cannot see. That absence IS the fix, so the trigger has to be a delay.
 *
 * The delay has to clear TWO windows, not one. The measured shape (instrumented run, warm
 * image, this laptop): container ready 1.3 s, build 0.4 s, pre-snapshot 9.7 s, visible suite
 * 7.5 s, post-snapshot 9.7 s, session A's body 28.7 s end to end.
 *
 * - **Session A**, where this writer is spawned: it starts at the earliest when the suite
 *   starts, 11.4 s in, so the longest it can have to wait for A's post-snapshot to finish is
 *   28.7 − 11.4 ≈ 17.3 s, and the whole session including teardown is gone ~19 s after the
 *   writer's own start.
 * - **Session B**, where the independent check imports the built artifact — which re-exports
 *   the candidate's allowed source path, so the candidate's module-level code runs there too
 *   and a writer it spawns in B has its own import-to-post-snapshot window of ~12 s (suite
 *   1.9 s plus the post-snapshot 9.7 s) to clear before B's container is gone as well.
 *
 * Sixty seconds, not thirty: the measured numbers come from a warm, unloaded dev machine, and
 * that is exactly the measurement the four-minute verifier deadline exists because we do not
 * trust under CI load. A longer delay is strictly safer in both directions, because the only
 * thing on the other side of it is a container that no longer exists.
 *
 * The margin only has to cover one direction. A write that lands EARLY is caught as a tamper
 * and this test fails loudly — it cannot pass for the wrong reason. A write that lands after
 * a session is over cannot write at all: its container is gone. Which is the property.
 */
const ARM_AFTER_MS = 60_000
/** How long a writer keeps rewriting once armed; it must outlast any snapshot it must cross. */
const WRITE_FOR_MS = 60_000

/**
 * A module-level payload that spawns a detached, unref'd writer, prepended to the reference
 * repair so the visible suite genuinely passes.
 *
 * `armAfterMs` is the only difference between the two adversarial candidates. The writer
 * overwrites the built artifact with a marker stub whose `spawnProcess` never rejects, so it
 * FAILS the independent check rather than satisfying it: what is being proven is that a
 * mutation of the oracle's input either cannot reach it or is detected, not that the mutation
 * was a clever one. Each rewrite carries a counter, so the artifact's bytes differ between any
 * two snapshots that straddle a write — the detection proof does not depend on winning a race.
 */
async function adversarialCandidate(armAfterMs: number): Promise<string> {
  const dist = "/workspace/packages/devkit/dist/testing/index.js"
  const writer = `
const fs = require('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dist = ${JSON.stringify(dist)}
// The marker the oracle would read instead of the real artifact. Its spawnProcess never
// rejects, which is the opposite of what the independent check demands, so this mutation
// sabotages the candidate rather than rescuing it. The counter is what makes two snapshots of
// this file differ, which is the thing under test.
const stub = (n) =>
  'export const spawnProcess = async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" })\\n' +
  '// tamper ' + n + '\\n'
;(async () => {
  await sleep(${armAfterMs})
  const stop = Date.now() + ${WRITE_FOR_MS}
  let n = 0
  while (Date.now() < stop) {
    try { fs.writeFileSync(dist, stub(n)) } catch {}
    n += 1
    await sleep(100)
  }
})()
`
  // The payload imports its own `spawn` under a private name rather than borrowing the one
  // the reference file happens to import at its first line: a change to that file's imports
  // must not silently turn this payload into a no-op.
  const payload = `import { spawn as tamperSpawn } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"

// Adversarial fixture. Arms only inside the verifier's container: TASK.md at the workspace
// root is written by the factory's own workspace definition and exists nowhere else, so this
// is inert when the same source is compiled or imported on a developer's machine.
if (existsSync("/workspace/TASK.md")) {
  try {
    // One writer per container, however many vitest workers import this module.
    writeFileSync("/tmp/b4-factory-tamper.lock", "1", { flag: "wx" })
    tamperSpawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
      detached: true,
      stdio: "ignore",
    }).unref()
  } catch {}
}

`
  return payload + (await applyReference(TASK))
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const verify = async (changes: Record<string, string>, id: string) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-tamper-"))
  dirs.push(dir)
  const artifacts = createArtifactStore(join(dir, "artifacts"))
  const receipt = await createDockerVerifier(artifacts).verify(
    {
      workOrderId: id,
      taskId: TASK,
      candidateDigest: "b".repeat(64),
      changes,
      policyDigest: policy.policyDigest,
    },
    AbortSignal.timeout(budget + 30_000),
  )
  return { receipt, artifacts }
}

const summary = (receipt: Receipt) => receipt.checks.map((c) => `${c.id}:${c.verdict}`)

/** One check's stored output, read back through the store that hashed it. */
const evidenceOf = async (artifacts: ArtifactStore, receipt: Receipt, checkId: string) => {
  const check = receipt.checks.find((c) => c.id === checkId)
  expect(check, `the receipt carries a ${checkId} check`).toBeDefined()
  return await artifacts.read(check?.evidence[0]?.digest as string)
}

describe("a candidate that tries to rewrite the artifact its independent oracle grades", () => {
  it(
    "cannot reach the oracle from the visible session: it is graded in another container",
    async () => {
      const { receipt } = await verify(
        { [allowed]: await adversarialCandidate(ARM_AFTER_MS) },
        "wo-tamper-late",
      )
      // The oracle read the artifact its OWN build produced, in a container the visible
      // suite's test code never ran in.
      //
      // What the old single-container design would have done with THIS payload is: rejected
      // it as an `independent` tamper. With the published phase timings the arm point falls
      // just after the old design's 1.9 s independent suite, inside its post-snapshot — so the
      // test does discriminate between the two designs, but the difference it shows is
      // `independent:fail` versus `pass`, not a forged verdict. The payload that would have
      // CHOSEN the oracle's bytes is one armed a few seconds earlier, landing between the old
      // design's pre-independent snapshot and its suite. That is the attack this change makes
      // impossible rather than merely detectable, and it is why the delay here is generous:
      // the property under test is that no arm point at all can reach the oracle.
      expect(summary(receipt)).toEqual(["visible:pass", "independent:pass"])
      expect(receipt.verdict).toBe("pass")
    },
    budget + 60_000,
  )

  it(
    "is still rejected as a tamper when it mutates inside the window it is graded in",
    async () => {
      // Armed immediately, so it writes throughout the visible suite. This needs no clock
      // margin at all: the payload runs at the suite's first import, which is necessarily
      // after the pre-snapshot, and it keeps writing past the post-snapshot, so the two
      // snapshots of the window cannot agree.
      const { receipt, artifacts } = await verify(
        { [allowed]: await adversarialCandidate(0) },
        "wo-tamper-during",
      )
      // One check only: the run stops at the tamper, and the mutation lands in the visible
      // window, so that is the check the receipt names — and the independent session is never
      // started, because the verdict is already decided.
      expect(summary(receipt)).toEqual(["visible:fail"])
      expect(receipt.verdict).toBe("fail")
      // A `visible:fail` is also what a candidate that simply fails the suite produces. Only
      // the evidence says WHY the run stopped, so assert the tamper's own sentence: without it
      // the test would pass on a coincidence.
      expect(await evidenceOf(artifacts, receipt, "visible")).toContain(
        "a suite mutated the workspace during visible",
      )
    },
    budget + 60_000,
  )

  it(
    "still admits the same repair without the payload, so the rule is not reject-everything",
    async () => {
      const { receipt } = await verify({ [allowed]: await applyReference(TASK) }, "wo-tamper-clean")
      expect(summary(receipt)).toEqual(["visible:pass", "independent:pass"])
      expect(receipt.verdict).toBe("pass")
    },
    budget + 60_000,
  )
})
