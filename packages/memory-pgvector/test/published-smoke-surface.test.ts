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

it.each(["@b4run/memory-pgvector"])(
  "exports what the release smoke probes import from %s",
  (specifier) => {
    const declared = PUBLISHED_PROBE_IMPORTS[specifier] ?? {}
    expect(Object.keys(declared), "the smoke surface must declare this entry").not.toHaveLength(0)
    const { actual, expected } = publishedProbeExpectation(packageDir, specifier, declared)
    expect(actual).toEqual(expected)
  },
  30_000,
)
