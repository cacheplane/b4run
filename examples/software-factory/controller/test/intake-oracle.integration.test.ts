import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { proveOracle } from "../src/lib/intake/oracle.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { configureCatalog, resetCatalogForTests, tasksDir } from "../src/lib/targets/catalog.ts"
import { captureTargetBaseline } from "../src/lib/verification/baseline.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { loadPolicy } from "../src/lib/verification/policy.ts"

/**
 * The oracle proof against the real verifier, in the `cli-flags` image. The shipped
 * `cli-flags` task stands in for a drafted one: copied under a generated-tasks directory as
 * a work order's task, minus the reference repair a draft never has. Its pinned bytes ARE the
 * defect, so its independent check must fail on the unpatched baseline — which is exactly
 * what makes a drafted check an oracle. Runs only under `test:sandbox` (Docker; the image is
 * built or re-verified by the lanes' global setup, `lane-images.global.ts`), like its siblings.
 */
let dir: string
afterEach(() => {
  resetCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** The shipped task as a generated task under `id`: the catalog then resolves it by that id. */
function materialise(generated: string, id: string): string {
  const directory = join(generated, id)
  cpSync(join(tasksDir, "cli-flags"), directory, {
    recursive: true,
    filter: (source) => !/(?:^|\/)(?:reference|defect)\.patch$/.test(source),
  })
  const manifest = JSON.parse(readFileSync(join(directory, "task.json"), "utf8")) as {
    id: string
  }
  writeFileSync(join(directory, "task.json"), `${JSON.stringify({ ...manifest, id }, null, 2)}\n`)
  return directory
}

const prove = async (id: string) => {
  const policy = loadPolicy(id)
  const signal = AbortSignal.timeout(280_000)
  const baseline = await captureTargetBaseline(id, signal, { captureRoot: dir })
  return proveOracle({
    verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts")), {
      stagingRoot: dir,
    }),
    workOrderId: id,
    taskId: id,
    policyDigest: policy.policyDigest,
    baselineDigest: baseline.digest,
    signal,
  })
}

describe("the oracle proof in the target's image", () => {
  it("proves a check that fails on the unpatched baseline", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-oracle-"))
    const generated = join(dir, "tasks")
    configureCatalog({ generatedTasksDir: generated })
    materialise(generated, "wo-oracle-fails")
    const proof = await prove("wo-oracle-fails")
    expect(proof.proven).toBe(true)
    expect(proof.receipt.verdict).toBe("fail")
    // Only the independent suite ran, and it is the check that failed: not a build error
    // and not a tamper, either of which proves nothing about the defect.
    expect(proof.receipt.checks.map((c) => [c.id, c.verdict])).toEqual([["independent", "fail"]])
    expect(proof.receipt.verifierIdentity).toMatch(/^docker:/)
  }, 300_000)

  it("refuses a check that passes on the baseline, naming the independent check", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-oracle-"))
    const generated = join(dir, "tasks")
    configureCatalog({ generatedTasksDir: generated })
    const directory = materialise(generated, "wo-oracle-passes")
    // The same assertion names, asserting nothing: a check that passes on the defect would
    // pass on anything, so it is not an oracle whatever the drafter called it.
    const names = (
      JSON.parse(readFileSync(join(directory, "checks.json"), "utf8")) as {
        independent: { assertions: string[] }
      }
    ).independent.assertions
    writeFileSync(
      join(directory, "checks", "independent.test.ts"),
      `import test from "node:test"\n${names.map((name) => `test(${JSON.stringify(name)}, () => {})\n`).join("")}`,
    )
    const proof = await prove("wo-oracle-passes")
    expect(proof.proven).toBe(false)
    if (proof.proven) throw new Error("unreachable")
    expect(proof.verdict).toBe("pass")
    expect(proof.checkId).toBe("independent")
  }, 300_000)
})
