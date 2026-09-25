import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("../src", import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : []
  })
}

/**
 * The controller reaches a worker by URL and token only. No source file may open a worker's
 * installation store or read its managed volumes directly: that would put the controller back
 * on the worker's host, filesystem and Docker daemon. Comments count: one that still describes
 * reading a worker's store is stale, and is reworded rather than this test weakened. The
 * retired app-root variables are pinned by `config.test.ts`, not here.
 */
describe("the controller has no path to a worker's filesystem", () => {
  for (const pattern of [
    /withManagedWorkspaceReader|openManagedWorkspaceReader/,
    /from "@b4run\/sqlite-storage"/,
    /openWorkspaceInstallation/,
    /\.b4\/workspaces/,
  ])
    it(`no source matches ${pattern}`, () => {
      const hits = sources(SRC).filter((file) => pattern.test(readFileSync(file, "utf8")))
      expect(hits).toEqual([])
    })
})
