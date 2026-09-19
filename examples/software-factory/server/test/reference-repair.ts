import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { loadFixture } from "../src/fixtures/catalog.ts"

/**
 * The historical reference repair: apply `fixtures/<id>/reference.patch` to a throwaway copy
 * and read the repaired source back. A candidate known to be correct, so a failing verdict
 * over it is the harness's fault and not the candidate's.
 */
export async function applyReference(id = "cli-flags"): Promise<string> {
  const fixture = loadFixture(id)
  const allowed = fixture.manifest.allowedSourcePaths[0] as string
  const temporary = await mkdtemp(join(tmpdir(), "factory-reference-"))
  try {
    await cp(join(fixture.directory, "project"), temporary, {
      recursive: true,
      filter: (path) => basename(path) !== "node_modules",
    })
    const applied = spawnSync("git", ["apply", join(fixture.directory, "reference.patch")], {
      cwd: temporary,
      encoding: "utf8",
      timeout: 10_000,
    })
    if (applied.status !== 0) throw new Error(`Historical patch failed: ${applied.stderr}`)
    return await readFile(join(temporary, allowed), "utf8")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
