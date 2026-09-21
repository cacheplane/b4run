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
 * Layer 3, adversarial: a candidate that tries to grade itself.
 *
 * The independent oracle for this task runs the BUILT artifact
 * (`packages/devkit/dist/testing/index.js`). A candidate's source is imported by the visible
 * vitest suite, so module-level code in it runs inside the verifier's container and can leave
 * a detached process behind — `--init` reaps zombies, not live detached children. That process
 * can overwrite the built artifact after the visible suite has been graded, so the builder
 * would choose the bytes its own oracle reads.
 *
 * The tamper comparison used to drop every path under the target's `snapshotIgnore` prefixes,
 * which for this target is exactly `packages/devkit/dist/` — the one directory the oracle
 * reads. It no longer excludes anything, so this candidate is rejected with a tamper.
 *
 * Of the two directions this primitive has, the payload here exercises the self-sabotaging
 * one: it installs an artifact that FAILS the independent check. The dangerous mirror image —
 * a defective source whose writer installs a correct artifact and forges a pass — is described
 * in prose in the spec's risks. Exercising one direction is enough for the property the fix
 * guarantees, because the comparison is verdict-blind: it asserts only that the workspace
 * after a suite equals the workspace before it, so it cannot tell the two directions apart and
 * a proof for either is a proof for both. Sabotage is the direction a test can assert cheaply,
 * since an unmodified independent check already distinguishes the stub from the real artifact.
 */
const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const policy = loadPolicy(TASK)
const allowed = task.manifest.allowedSourcePaths[0] as string
const budget = task.target.resources.verifierDeadlineMs

/**
 * How long the detached writer waits after the independent check file appears before it starts
 * overwriting the built artifact.
 *
 * A fixed delay measured from the start of the run cannot work here, and the measurement is
 * worth recording: each workspace snapshot takes ~11s and the independent suite itself takes
 * ~0.2s, so the window a pure stopwatch would have to hit is ~200ms wide roughly 35s in. The
 * writer therefore takes its cue from the workspace instead: the verifier installs
 * `checks/<independent>.ts` only AFTER the visible suite's post-snapshot, so that file's
 * appearance marks the start of the independent phase. The settle below covers the gap until
 * the pre-independent snapshot has been taken, and the writer then keeps rewriting for
 * {@link WRITE_FOR_MS} so it does not have to hit any single instant.
 */
const ARM_SETTLE_MS = 2_000
/** How long the writer keeps rewriting, which must outlast the post-independent snapshot. */
const WRITE_FOR_MS = 60_000

/**
 * The reference repair (so the visible suite genuinely passes) with a module-level payload
 * prepended: a detached, unref'd child that overwrites the built artifact with a marker stub.
 * The stub's `spawnProcess` never rejects, so it FAILS the independent check rather than
 * satisfying it — what is being proven is that a persistent mutation of the oracle's input is
 * detected, not that the mutation was a clever one.
 *
 * Each rewrite carries a counter, so the artifact's bytes differ between the pre- and
 * post-independent snapshots no matter which instant either snapshot read it — the proof does
 * not depend on winning a race.
 */
async function adversarialCandidate(): Promise<string> {
  const dist = "/workspace/packages/devkit/dist/testing/index.js"
  const writer = `
const fs = require('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = ${JSON.stringify(`/workspace/${task.checks.independent.file}`)}
const dist = ${JSON.stringify(dist)}
// The marker the oracle would read instead of the real artifact. Its spawnProcess never
// rejects, which is the opposite of what the independent check demands, so this mutation
// sabotages the candidate rather than rescuing it. The counter is what makes two snapshots of
// this file differ, which is the thing under test.
const stub = (n) =>
  'export const spawnProcess = async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" })\\n' +
  '// tamper ' + n + '\\n'
;(async () => {
  const giveUp = Date.now() + 180000
  while (Date.now() < giveUp && !fs.existsSync(check)) await sleep(50)
  await sleep(${ARM_SETTLE_MS})
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
    "is rejected as a tamper, not graded on the bytes it chose",
    async () => {
      const { receipt, artifacts } = await verify(
        { [allowed]: await adversarialCandidate() },
        "wo-tamper",
      )
      // One check only: the run stops at the tamper, and the mutation lands in the independent
      // window, so that is the check the receipt names.
      expect(summary(receipt)).toEqual(["independent:fail"])
      expect(receipt.verdict).toBe("fail")
      // `independent:fail` is also what a candidate that simply fails the oracle produces, and
      // this candidate would fail it either way. Only the evidence says WHY the run stopped,
      // so assert the tamper's own sentence: without it the test would pass on a coincidence.
      expect(await evidenceOf(artifacts, receipt, "independent")).toContain(
        "a suite mutated the workspace during independent",
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
