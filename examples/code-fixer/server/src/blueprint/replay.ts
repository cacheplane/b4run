import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { script } from "@b4run/testing"
import { fixturesRoot, loadManifest } from "./fixture-catalog.js"

export const taskInput =
  "Read TASK.md, reproduce the failure, repair the permitted source, verify it, and request export for review."

/** Offline wiring test only. Never presented as a model-generated repair. */
export async function replayFixture(id: string) {
  const manifest = await loadManifest(id)
  const temporary = await mkdtemp(join(tmpdir(), "b4-code-fixer-replay-"))
  try {
    await cp(join(fixturesRoot, id, "project"), temporary, {
      recursive: true,
      filter: (path) => basename(path) !== "node_modules",
    })
    const applied = spawnSync("git", ["apply", join(fixturesRoot, id, "reference.patch")], {
      cwd: temporary,
      encoding: "utf8",
      timeout: 10_000,
    })
    if (applied.status !== 0) throw new Error(`Historical patch failed: ${applied.stderr}`)
    let fixture = script()
      .user(taskInput)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("runBash", { command: "npm test" })
    for (const path of manifest.allowedSourcePaths) {
      fixture = fixture
        .callsTool("readFile", { path })
        .callsTool("writeFile", { path, content: await readFile(join(temporary, path), "utf8") })
    }
    return fixture
      .callsTool("runBash", { command: "npm test" })
      .callsTool("exportForReview", {})
      .replies("Verified patch exported for review.")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
