import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { isolatedApp } from "../evaluation/isolated-app.ts"
import { fixtureDirectory } from "../fixtures/catalog.ts"

it.each(["cli-flags", "nullable-inputs"])(
  "materializes only %s in an ordinary copied app",
  async (id) => {
    const root = await isolatedApp(undefined, id)
    try {
      expect(await readFile(join(root, "sample/manifest.json"), "utf8")).toBe(
        await readFile(join(fixtureDirectory(id), "manifest.json"), "utf8"),
      )
      expect(await readdir(join(root, "scripts"))).toEqual(["prepare.ts"])
      expect(await readdir(join(root, "src"))).not.toContain("evaluation")
      expect(await readdir(root)).not.toContain("fixtures")
      const config = await readFile(join(root, "b4.config.ts"), "utf8")
      expect(config).not.toContain("B4_CODE_FIXER_TASK")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
