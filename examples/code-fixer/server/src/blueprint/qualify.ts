import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fixturesRoot, loadManifest, validateDependencies } from "./fixture-catalog.js"

interface Result {
  status: number | null
  output: string
  durationMs?: number
}
export function assessQualification(
  pattern: string,
  baseline: Result,
  repaired: Result,
  independent: Result,
): boolean {
  return (
    baseline.status !== null &&
    baseline.status !== 0 &&
    baseline.output.includes(pattern) &&
    repaired.status === 0 &&
    independent.status === 0
  )
}

function command(cwd: string, executable: string, args: string[]): Result {
  const started = performance.now()
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    durationMs: Math.round(performance.now() - started),
  }
}

// Maintainer-only qualification of checked-in historical/reference code.
// Never pass an agent-submitted patch here; those require an isolated verifier.
export async function qualifyFixture(id: string) {
  const manifest = await loadManifest(id)
  const fixture = join(fixturesRoot, manifest.id)
  const root = await mkdtemp(join(tmpdir(), "b4-fixture-qualification-"))
  try {
    await cp(join(fixture, "project"), root, {
      recursive: true,
      filter: (p) => basename(p) !== "node_modules",
    })
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"))
    validateDependencies(pkg, lock)
    const setup = command(root, "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"])
    if (setup.status !== 0) throw new Error(`Fixture install failed: ${setup.output}`)
    const baseline = command(root, "npm", ["test"])
    if (baseline.status === 0 || !baseline.output.includes(manifest.failurePattern))
      throw new Error(`Wrong baseline failure: ${baseline.output}`)
    const apply = command(root, "git", ["apply", join(fixture, "reference.patch")])
    if (apply.status !== 0) throw new Error(`Reference patch failed: ${apply.output}`)
    const repaired = command(root, "npm", ["test"])
    await cp(join(fixture, "checks"), join(root, "checks"), { recursive: true })
    const independent = command(root, "npm", ["run", "check:independent"])
    return {
      id: manifest.id,
      sourceCommit: manifest.sourceCommit,
      qualified: assessQualification(manifest.failurePattern, baseline, repaired, independent),
      setup,
      baseline,
      repaired,
      independent,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
