import { resolve } from "node:path"
import { type BuildOptions, build } from "esbuild"
import { expect, test } from "vitest"

const packageRoot = resolve(import.meta.dirname, "..")
// Match the API-reference compatibility guard: optional model peers must not
// supply the evidence that this B4-owned entry point requires Node.
const modelLayerExternals = ["@langchain/*", "langchain", "openai"]
const options: BuildOptions = {
  bundle: true,
  write: false,
  format: "esm",
  external: modelLayerExternals,
  logLevel: "silent",
}

test("ui rejects browser bundling even when the model layer is external", async () => {
  const entryPoints = [resolve(packageRoot, "src/ui.ts")]

  const result = build({ ...options, entryPoints, platform: "browser" }).then(() => "bundled")

  await expect(result).rejects.toMatchObject({
    errors: expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("node:async_hooks") }),
    ]),
  })
})

test("ui bundles on Node with the same external model peers", async () => {
  const entryPoints = [resolve(packageRoot, "src/ui.ts")]

  const result = await build({ ...options, entryPoints, platform: "node" })

  expect(result.outputFiles?.[0]?.text).toContain("emitToolStep")
  expect(result.outputFiles?.[0]?.text).toContain("toolStepMiddleware")
})

test.each(["index", "define-entry", "route-module"])(
  "existing %s entry remains browser bundleable",
  async (entry) => {
    const entryPoints = [resolve(packageRoot, `src/${entry}.ts`)]

    const result = await build({ ...options, entryPoints, platform: "browser" })

    expect(result.outputFiles?.[0]?.text).toContain(
      "define-entry" === entry ? "defineEntry" : "normalizeRouteModule",
    )
  },
)
