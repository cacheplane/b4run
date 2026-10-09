import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { publishedProbeExpectation } from "../../../scripts/lib/published-export-kinds.mjs"
import {
  GRAPH_ADAPTER_CONTRACT,
  PUBLISHED_PROBE_IMPORTS,
} from "../../../scripts/release/smoke/published-surface.mjs"
import { graphAdapter } from "../src/index.js"

// The release smoke lanes install this package from npm and import what
// scripts/release/smoke/published-surface.mjs declares. Those lanes first run after
// publication, from the frozen candidate, so a renamed or removed export would fail
// a release that cannot be fixed in place. Hold the declaration to the package's
// real exports map and build here, where every pull request runs.
const packageDir = fileURLToPath(new URL("..", import.meta.url))

it.each(["@b4run/langgraph"])(
  "exports what the release smoke probes import from %s",
  (specifier) => {
    const declared = PUBLISHED_PROBE_IMPORTS[specifier] ?? {}
    expect(Object.keys(declared), "the smoke surface must declare this entry").not.toHaveLength(0)
    const { actual, expected } = publishedProbeExpectation(packageDir, specifier, declared)
    expect(actual).toEqual(expected)
  },
  30_000,
)

it("keeps the backend adapter contract the release smoke asserts of graphAdapter", () => {
  const adapter = graphAdapter as unknown as Record<string, unknown>
  expect(adapter.kind).toBe(GRAPH_ADAPTER_CONTRACT.kind)
  for (const method of GRAPH_ADAPTER_CONTRACT.methods) {
    expect(typeof adapter[method], method).toBe("function")
  }
})
