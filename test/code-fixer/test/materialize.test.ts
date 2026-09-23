import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { preparedImageTag } from "../../../examples/code-fixer/server/src/project/image.ts"
import { sandboxImage } from "../../../examples/code-fixer/server/src/project/workspace.ts"
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

it("gives each historical sample its own content-addressed image", async () => {
  const roots = [
    await isolatedApp(undefined, "cli-flags"),
    await isolatedApp(undefined, "nullable-inputs"),
  ]
  try {
    const [cliFlags, nullable] = roots.map((root) => preparedImageTag(root))
    // The copied cli-flags app has the example's own inputs, so both name one image.
    expect(cliFlags).toBe(sandboxImage)
    expect(nullable).not.toBe(sandboxImage)
    expect(await readFile(join(roots[1] ?? "", "Dockerfile"), "utf8")).toContain(
      "/opt/fixtures/nullable-inputs/",
    )
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  }
})
