import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Receipt } from "../src/domain/work-order.ts"
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
 * prepended: a detached, unref'd child that overwrites the built artifact with a stub whose
 * `spawnProcess` never rejects, which is precisely what the independent check asserts.
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
// The stub the oracle would read: a spawnProcess that never rejects, which is the one thing
// the independent check asserts. The counter is what makes two snapshots of this file differ.
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
  const payload = `import { existsSync, writeFileSync } from "node:fs"

// Adversarial fixture. Arms only inside the verifier's container: TASK.md at the workspace
// root is written by the factory's own workspace definition and exists nowhere else, so this
// is inert when the same source is compiled or imported on a developer's machine.
if (existsSync("/workspace/TASK.md")) {
  try {
    // One writer per container, however many vitest workers import this module.
    writeFileSync("/tmp/b4-factory-tamper.lock", "1", { flag: "wx" })
    spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
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
  return await createDockerVerifier(artifacts).verify(
    {
      workOrderId: id,
      taskId: TASK,
      candidateDigest: "b".repeat(64),
      changes,
      policyDigest: policy.policyDigest,
    },
    AbortSignal.timeout(budget + 30_000),
  )
}

const summary = (receipt: Receipt) => receipt.checks.map((c) => `${c.id}:${c.verdict}`)

describe("a candidate that tries to rewrite the artifact its independent oracle grades", () => {
  it(
    "is rejected as a tamper, not graded on the bytes it chose",
    async () => {
      const receipt = await verify({ [allowed]: await adversarialCandidate() }, "wo-tamper")
      // One check only: the run stops at the tamper, and the mutation lands in the independent
      // window, so that is the check the receipt names.
      expect(summary(receipt)).toEqual(["independent:fail"])
      expect(receipt.verdict).toBe("fail")
    },
    budget + 60_000,
  )

  it(
    "still admits the same repair without the payload, so the rule is not reject-everything",
    async () => {
      const receipt = await verify({ [allowed]: await applyReference(TASK) }, "wo-tamper-clean")
      expect(summary(receipt)).toEqual(["visible:pass", "independent:pass"])
      expect(receipt.verdict).toBe("pass")
    },
    budget + 60_000,
  )
})
