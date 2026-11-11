import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { publishedProbeExpectation } from "../../../scripts/lib/published-export-kinds.mjs"
import { PUBLISHED_PROBE_IMPORTS } from "../../../scripts/release/smoke/published-surface.mjs"

// The release smoke lanes install this package from npm and import what
// scripts/release/smoke/published-surface.mjs declares. Those lanes first run after
// publication, from the frozen candidate, so a renamed or removed export would fail
// a release that cannot be fixed in place. Hold the declaration to the package's
// real exports map and build here, where every pull request runs.
const packageDir = fileURLToPath(new URL("..", import.meta.url))

it("pins the published LangChain runtime stack to the tested workspace versions", () => {
  const manifests = [
    {
      root: new URL("../", import.meta.url),
      packages: ["langchain", "@langchain/langgraph", "@langchain/openai"],
    },
    { root: new URL("../../core/", import.meta.url), packages: ["@langchain/langgraph"] },
  ]
  for (const { root, packages } of manifests) {
    const { dependencies, name } = JSON.parse(
      readFileSync(new URL("package.json", root), "utf8"),
    ) as { dependencies: Record<string, string>; name: string }
    for (const dependency of packages) {
      const { version } = JSON.parse(
        readFileSync(new URL(`node_modules/${dependency}/package.json`, root), "utf8"),
      ) as { version: string }
      expect(dependencies[dependency], `${name} publishes ${dependency}`).toBe(version)
    }
  }
})

it.each(["@b4run/langchain"])(
  "exports what the release smoke probes import from %s",
  (specifier) => {
    const declared = PUBLISHED_PROBE_IMPORTS[specifier] ?? {}
    expect(Object.keys(declared), "the smoke surface must declare this entry").not.toHaveLength(0)
    const { actual, expected } = publishedProbeExpectation(packageDir, specifier, declared)
    expect(actual).toEqual(expected)
  },
  30_000,
)
