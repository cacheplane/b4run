import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

/**
 * Once per `test:sandbox` run: a registry directory of the run's own, handed to every lane file
 * (`provide`), and the two targets the lanes run at their default pins built (or re-verified)
 * in it. The opt-in `cli` run (`FACTORY_TEST_CLI_TARGET=1`, `test:sandbox:cli`) needs neither
 * and builds `cli` in its own lane. The teardown removes the registry file, never an image.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "b4-factory-lane-images-"))
  project.provide("laneImagesDir", dir)
  if (process.env.FACTORY_TEST_CLI_TARGET !== "1") {
    const registry = openLaneImages(dir)
    try {
      for (const id of ["cli-flags", "devkit"]) {
        const started = Date.now()
        const ensured = await registry.ensure(loadTargetRecipe(id), {
          signal: AbortSignal.timeout(1_200_000),
        })
        process.stderr.write(
          `lane images: ${id} ${ensured.image.localId} (${ensured.build ? `built in ${Date.now() - started} ms` : "recorded"})\n`,
        )
      }
    } finally {
      registry.close()
    }
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
