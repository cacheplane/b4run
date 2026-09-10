import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { publishedHarnessProbeSource } from "../smoke/published-harness.mjs"
import { edgeEntryProbeSource } from "../smoke/runtime-targets.mjs"

const execute = promisify(execFile)
async function withConsumer(operation, adapter = '{ kind: "graph", execute() {}, stream() {} }') {
  const root = await mkdtemp(join(tmpdir(), "b4-public-contract-"))
  try {
    for (const [name, source, exports] of [
      [
        "sdk",
        "export const agent = () => {}; export const allow = () => {}; export const reject = () => {}; export const defineMiddleware = () => {}",
        { ".": "./index.js", "./pure": "./pure.js" },
      ],
      ["core", "export const discoverRoutes = () => {}", { "./node": "./index.js" }],
      ["langgraph", `export const graphAdapter = ${adapter}`, "./index.js"],
      ["testing", "export const createAimock = () => {}", "./index.js"],
      ["ag-ui", "export const toAguiEvents = () => {}", "./index.js"],
      ["postgres-storage", "export const createPostgresThreadsStore = () => {}", "./index.js"],
    ]) {
      const directory = join(root, "node_modules", "@b4run", name)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: `@b4run/${name}`, type: "module", exports }),
      )
      await writeFile(join(directory, "index.js"), source)
      // The published pure entry exports path/hash helpers, never agent().
      if (name === "sdk")
        await writeFile(join(directory, "pure.js"), "export const pathHash = () => {}")
    }
    return await operation(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("edge consumer imports agent from its public package entry", async () => {
  await withConsumer(async (root) => {
    await writeFile(
      join(root, "edge.mjs"),
      `${edgeEntryProbeSource()}\nif (edgeSurface().join() !== "function,function") throw new Error("missing edge exports")`,
    )
    await execute(process.execPath, ["edge.mjs"], { cwd: root })
  })
})

test("published harness runtime accepts the shipped adapter object", async () => {
  await withConsumer(async (root) => {
    await writeFile(join(root, "harness.mjs"), publishedHarnessProbeSource())
    for (const lane of ["framework", "runtime", "smoke"])
      await execute(process.execPath, ["harness.mjs", lane, "0.8.24"], { cwd: root })
  })
})

test("published harness still rejects a broken adapter contract", async () => {
  for (const adapter of [
    "() => {}",
    '{ kind: "workflow", execute() {}, stream() {} }',
    '{ kind: "graph", execute() {} }',
  ])
    await withConsumer(async (root) => {
      await writeFile(join(root, "harness.mjs"), publishedHarnessProbeSource())
      await assert.rejects(
        execute(process.execPath, ["harness.mjs", "runtime", "0.8.24"], { cwd: root }),
      )
    }, adapter)
})
