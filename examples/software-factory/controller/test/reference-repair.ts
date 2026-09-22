import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureTarget } from "../src/lib/targets/archive.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"

/**
 * The historical reference repair: apply `tasks/<id>/reference.patch` to a throwaway capture
 * of the task's baseline and read the repaired source back. A candidate known to be correct,
 * so a failing verdict over it is the harness's fault and not the candidate's.
 *
 * The capture is taken under a temporary app root, so it never disturbs the builder's or the
 * controller's own capture directories.
 */
export async function applyReference(id = "cli-flags"): Promise<string> {
  const task = loadTask(id)
  // This helper returns ONE file's repaired bytes, and its callers index the same way. A task
  // that permits a second path would silently have that path's repair dropped, so refuse it
  // here rather than return a half-applied candidate.
  if (task.manifest.allowedSourcePaths.length !== 1)
    throw new Error("Reference repair helper assumes one allowed path")
  const allowed = task.manifest.allowedSourcePaths[0] as string
  const appRoot = await mkdtemp(join(tmpdir(), "factory-reference-"))
  try {
    const captured = captureTarget(task, "test", { appRoot })
    const applied = spawnSync("git", ["apply", join(task.directory, "reference.patch")], {
      cwd: captured.absolute,
      encoding: "utf8",
      timeout: 10_000,
    })
    if (applied.status !== 0) throw new Error(`Historical patch failed: ${applied.stderr}`)
    return await readFile(join(captured.absolute, allowed), "utf8")
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
}
