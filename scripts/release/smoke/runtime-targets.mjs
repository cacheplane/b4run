#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { makeTempDir, publicNpmEnvironment, removeDir } from "../../lib/published-artifacts.mjs"
import {
  createStrictSmokeProcessRunner,
  pickStrictSmokeCommandOptions,
  strictContainmentReceiptDetail,
} from "../smoke-process-runner.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const ESBUILD_VERSION = "0.28.1"

export async function runRuntimeTargetsSmoke(options, overrides = {}) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Runtime-target smoke command execution requires a strictRunner")
  }
  return executeSmokeLane(
    { lane: "runtime-targets", ...options },
    (context) => executeRuntimeTargetsSmoke(options, context, overrides),
    overrides,
  )
}

export async function executeRuntimeTargetsSmoke(
  options,
  { check, deferCleanup, captureInstallation = async () => {} },
  overrides = {},
) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Runtime-target smoke command execution requires a strictRunner")
  }
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const dependencies = {
    makeTempDir,
    removeDir,
    writeProbeFiles,
    ...overrides,
    runCommand: (command, args, runOptions) =>
      strictRunner.runCommand(command, args, productionCommandOptions(runOptions)),
    probeContainment: strictRunner.probe,
  }

  await check(
    "containment",
    strictContainmentReceiptDetail(dependencies.env),
    dependencies.probeContainment,
  )
  const root = await check("temporary-project", "clean runtime-target consumer created", () =>
    dependencies.makeTempDir("b4-published-runtime-targets-"),
  )
  deferCleanup("cleanup", "runtime-target consumer removed", () => dependencies.removeDir(root))

  await check(
    "exact-install",
    "exact Node and edge packages installed from public npm",
    async () => {
      await dependencies.runCommand("npm", ["init", "-y"], { cwd: root })
      await dependencies.runCommand(
        "npm",
        [
          "install",
          "--save-exact",
          "--package-lock=false",
          `@b4run/sdk@${options.version}`,
          `@b4run/core@${options.version}`,
          `@b4run/langgraph@${options.version}`,
          `@b4run/ag-ui@${options.version}`,
          `@b4run/postgres-storage@${options.version}`,
          `esbuild@${ESBUILD_VERSION}`,
        ],
        { cwd: root },
      )
      await captureInstallation("exact-install", root)
    },
  )
  await check("probe-files", "runtime-target probes created", () =>
    dependencies.writeProbeFiles(root),
  )
  await check("node-runtime", "Node imports and representative runtime passed", () =>
    dependencies.runCommand("node", ["node-runtime.mjs"], { cwd: root }),
  )
  await check("edge-bundle", "edge target bundled without Node builtins", () =>
    dependencies.runCommand(
      "npm",
      [
        "exec",
        "--",
        "esbuild",
        "edge-entry.mjs",
        "--bundle",
        "--platform=browser",
        "--format=esm",
        "--outfile=edge-bundle.mjs",
      ],
      { cwd: root },
    ),
  )
  await check("edge-import", "bundled edge target imported and executed", () =>
    dependencies.runCommand("node", ["edge-import.mjs"], { cwd: root }),
  )
}

export async function writeProbeFiles(root) {
  await Promise.all([
    writeFile(path.join(root, "node-runtime.mjs"), nodeRuntimeProbeSource(), "utf8"),
    writeFile(path.join(root, "edge-entry.mjs"), edgeEntryProbeSource(), "utf8"),
    writeFile(path.join(root, "edge-import.mjs"), edgeImportProbeSource(), "utf8"),
  ])
}

export function nodeRuntimeProbeSource() {
  return `import assert from "node:assert/strict"
import { agent } from "@b4run/sdk"
import { discoverRoutes } from "@b4run/core/node"
import { graphAdapter } from "@b4run/langgraph"
import { toAguiEvents } from "@b4run/ag-ui"

for (const [name, value] of Object.entries({ agent, discoverRoutes, toAguiEvents })) {
  assert.equal(typeof value, "function", name + " must be a function")
}

assert.equal(typeof graphAdapter, "object", "graphAdapter must be a backend adapter object")
assert.notEqual(graphAdapter, null, "graphAdapter must be a backend adapter object")
assert.equal(graphAdapter.kind, "graph", "graphAdapter must declare the graph backend kind")
for (const method of ["execute", "stream"]) {
  assert.equal(
    typeof graphAdapter[method],
    "function",
    "graphAdapter." + method + " must be a function",
  )
}
`
}

export function edgeEntryProbeSource() {
  return `import { agent } from "@b4run/sdk"
import { createPostgresThreadsStore } from "@b4run/postgres-storage"

export function edgeSurface() {
  return [typeof agent, typeof createPostgresThreadsStore]
}
`
}

export function edgeImportProbeSource() {
  return `import assert from "node:assert/strict"
import { edgeSurface } from "./edge-bundle.mjs"
assert.deepEqual(edgeSurface(), ["function", "function"])
`
}

function productionCommandOptions(options = {}) {
  return {
    ...pickStrictSmokeCommandOptions(options),
    env: publicNpmEnvironment({
      home: options.cwd ?? process.cwd(),
      extra: options.env,
    }),
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  }
}

async function main() {
  await runRuntimeTargetsSmoke(parseSmokeLaneArgs(process.argv.slice(2)))
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(
      `RUNTIME TARGETS SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
