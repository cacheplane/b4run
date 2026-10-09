import assert from "node:assert/strict"
import test from "node:test"

import * as typescriptToolingProbe from "../../lib/typescript-tooling-probe.mjs"
import * as publishedArtifactSmoke from "../../published-artifact-smoke.mjs"
import * as publishedHarness from "../smoke/published-harness.mjs"
import {
  AG_UI_REMOVED_ROOT_TYPES,
  AG_UI_REMOVED_ROOT_VALUES,
  AG_UI_ROOT_CONSTANTS,
  AG_UI_ROOT_EXPORTS,
  AG_UI_ROOT_FUNCTIONS,
  AG_UI_ROOT_TYPES,
  GRAPH_ADAPTER_CONTRACT,
  PUBLISHED_PROBE_IMPORTS,
} from "../smoke/published-surface.mjs"
import * as runtimeTargets from "../smoke/runtime-targets.mjs"
import * as storage from "../smoke/storage.mjs"

// The packages' own tests compare published-surface.mjs with their real exports.
// This holds every installed-package probe to that declaration, so a probe that
// starts importing something new cannot bypass those guards.

const THREAD_ID = `published-uuid-${"0".repeat(32)}`

const PROBE_SOURCES = {
  "published-artifact-smoke.mjs": {
    module: publishedArtifactSmoke,
    sources: {
      agUiEsmProbeSource: () => publishedArtifactSmoke.agUiEsmProbeSource(),
      agUiTypeProbeSource: () => publishedArtifactSmoke.agUiTypeProbeSource(),
      dockerSandboxInstalledProbeSource: () =>
        [
          publishedArtifactSmoke.dockerSandboxInstalledProbeSource(THREAD_ID),
          publishedArtifactSmoke.dockerSandboxInstalledProbeSource(THREAD_ID, {
            imageEvidencePath: "docker-image.json",
          }),
        ].join("\n"),
      runtimeSmokeSource: () => publishedArtifactSmoke.runtimeSmokeSource(),
    },
  },
  "smoke/published-harness.mjs": {
    module: publishedHarness,
    sources: {
      publishedHarnessProbeSource: () => publishedHarness.publishedHarnessProbeSource(),
    },
  },
  "smoke/runtime-targets.mjs": {
    module: runtimeTargets,
    sources: {
      edgeEntryProbeSource: () => runtimeTargets.edgeEntryProbeSource(),
      edgeImportProbeSource: () => runtimeTargets.edgeImportProbeSource(),
      nodeRuntimeProbeSource: () => runtimeTargets.nodeRuntimeProbeSource(),
    },
  },
  "smoke/storage.mjs": {
    module: storage,
    sources: { postgresProbeSource: () => storage.postgresProbeSource() },
  },
  "lib/typescript-tooling-probe.mjs": {
    module: typescriptToolingProbe,
    sources: {
      typescriptToolingConsumerSource: () =>
        typescriptToolingProbe.typescriptToolingConsumerSource(),
      typescriptToolingProbeSource: () => typescriptToolingProbe.typescriptToolingProbeSource(),
      typescriptToolingSourceFiles: () =>
        Object.values(typescriptToolingProbe.typescriptToolingSourceFiles()).join("\n"),
    },
  },
}

const IMPORT =
  /^(\/\/ @ts-expect-error[^\n]*\n)?import (type )?(\{[^}]*\}|\* as \w+) from "(@b4run\/[^"]+)"/gmu

/** Every `@b4run/*` import statement of a probe source, by kind. */
function probeImports(source) {
  const imports = []
  for (const [, expectError, typeOnly, clause, specifier] of source.matchAll(IMPORT)) {
    if (clause.startsWith("*")) {
      imports.push({ kind: "namespace", name: "*", specifier })
      continue
    }
    for (const entry of clause.slice(1, -1).split(",")) {
      const trimmed = entry.trim()
      if (trimmed === "") continue
      const isType = typeOnly !== undefined || trimmed.startsWith("type ")
      const name = trimmed
        .replace(/^type /u, "")
        .split(/ as /u)[0]
        .trim()
      const kind = expectError
        ? isType
          ? "removed-type"
          : "removed-value"
        : isType
          ? "type"
          : "value"
      imports.push({ kind, name, specifier })
    }
  }
  return imports
}

function allProbeImports() {
  return Object.values(PROBE_SOURCES).flatMap(({ sources }) =>
    Object.values(sources).flatMap((source) => probeImports(source())),
  )
}

const sorted = (values) => [...new Set(values)].sort()

test("every exported probe source is held to the published surface", () => {
  for (const [file, { module, sources }] of Object.entries(PROBE_SOURCES)) {
    const generators = Object.keys(module).filter(
      (name) => typeof module[name] === "function" && /Source(?:Files)?$/u.test(name),
    )
    assert.deepEqual(
      sorted(generators),
      sorted(Object.keys(sources)),
      `${file}: a new probe source must be added to this test`,
    )
  }
})

test("the probes' named value imports are exactly the declared published surface", () => {
  const imports = allProbeImports().filter(({ kind }) => kind === "value")
  const actual = {}
  for (const { name, specifier } of imports) {
    actual[specifier] = sorted([...(actual[specifier] ?? []), name])
  }
  const expected = Object.fromEntries(
    Object.entries(PUBLISHED_PROBE_IMPORTS).map(([specifier, names]) => [
      specifier,
      sorted(Object.keys(names)),
    ]),
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(actual).sort(([left], [right]) => left.localeCompare(right))),
    Object.fromEntries(
      Object.entries(expected).sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
})

test("the TypeScript probe's AG-UI root types are exactly the declared ones", () => {
  const imports = allProbeImports()
  const byKind = (kind) =>
    sorted(
      imports
        .filter((entry) => entry.kind === kind)
        .map(({ specifier, name }) => `${specifier}:${name}`),
    )
  assert.deepEqual(byKind("type"), sorted(AG_UI_ROOT_TYPES.map((name) => `@b4run/ag-ui:${name}`)))
  assert.deepEqual(
    byKind("removed-type"),
    sorted(AG_UI_REMOVED_ROOT_TYPES.map((name) => `@b4run/ag-ui:${name}`)),
  )
  assert.deepEqual(
    byKind("removed-value"),
    sorted(AG_UI_REMOVED_ROOT_VALUES.map((name) => `@b4run/ag-ui:${name}`)),
  )
})

test("only the AG-UI root is imported whole, and its probe compares the declared list", () => {
  assert.deepEqual(
    allProbeImports()
      .filter(({ kind }) => kind === "namespace")
      .map(({ specifier }) => specifier),
    ["@b4run/ag-ui"],
  )
  const source = publishedArtifactSmoke.agUiEsmProbeSource()
  assert.ok(
    source.includes(
      `assert.deepEqual(Object.keys(root).sort(), [\n${AG_UI_ROOT_EXPORTS.map((name) => `  ${JSON.stringify(name)},`).join("\n")}\n])`,
    ),
  )
  for (const [name, value] of Object.entries(AG_UI_ROOT_CONSTANTS)) {
    assert.ok(source.includes(`assert.equal(root.${name}, ${JSON.stringify(value)})`), name)
  }
})

test("the declared AG-UI root is internally consistent", () => {
  assert.deepEqual(
    [...AG_UI_ROOT_EXPORTS],
    [...Object.keys(AG_UI_ROOT_CONSTANTS), ...AG_UI_ROOT_FUNCTIONS].sort(),
  )
  for (const [name, kind] of Object.entries(PUBLISHED_PROBE_IMPORTS["@b4run/ag-ui"])) {
    assert.ok(AG_UI_ROOT_EXPORTS.includes(name), `${name} must be in the exhaustive root list`)
    assert.equal(kind, Object.hasOwn(AG_UI_ROOT_CONSTANTS, name) ? "string" : "function", name)
  }
  for (const name of [...AG_UI_REMOVED_ROOT_TYPES, ...AG_UI_REMOVED_ROOT_VALUES]) {
    assert.ok(!AG_UI_ROOT_EXPORTS.includes(name), `${name} is both expected and removed`)
    assert.ok(!AG_UI_ROOT_TYPES.includes(name), `${name} is both expected and removed`)
  }
})

test("every probe that imports graphAdapter asserts the declared adapter contract", () => {
  const sources = Object.values(PROBE_SOURCES)
    .flatMap(({ sources }) => Object.values(sources).map((source) => source()))
    .filter((source) =>
      probeImports(source).some(({ kind, name }) => kind === "value" && name === "graphAdapter"),
    )
  assert.equal(sources.length, 2)
  for (const source of sources) {
    assert.ok(source.includes(`graphAdapter.kind, ${JSON.stringify(GRAPH_ADAPTER_CONTRACT.kind)}`))
    assert.ok(
      source.includes(
        `for (const method of [${GRAPH_ADAPTER_CONTRACT.methods.map((method) => JSON.stringify(method)).join(", ")}])`,
      ),
    )
  }
})
