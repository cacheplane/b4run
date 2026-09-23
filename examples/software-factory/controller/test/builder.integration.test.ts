import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { script } from "@b4run/testing"
import { createSourceBundle, verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterAll, beforeAll, expect, it } from "vitest"
import { BuilderManifestSchema, writeBuilderManifest } from "../src/lib/builder-manifest.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { captureTarget } from "../src/lib/targets/archive.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { type ServedBuilder, serveBuilder, toolCallsSeen, toolResults } from "./served-builder.ts"

/**
 * Layer 2: the real builder app, real typegen, real tool wiring, scripted model output, and
 * the builder's per-work-order resolver: ONE builder process for the `cli-flags` target, two
 * work orders, two threads, and each thread serves its own work order's workspace.
 *
 * Only the model is scripted. The route, the permission config, the tool loop, the resolver
 * and the container are all the real ones, which is why this lives in the Docker project:
 * the app configures a sandbox, so the run acquires one. Without Docker it fails rather than
 * skipping.
 *
 * The builder is configured by the controller's two files: the TARGET file (provider,
 * policy, permissions; one per process, written by `writeBuilderTarget`) and one MANIFEST
 * per work order (`writeBuilderManifest(task, dir, { workOrderId })`), which the resolver
 * loads by the thread's `metadata.factoryWorkOrderId`. The builder resolves no pin and
 * captures nothing of its own.
 */

const task = loadTask("cli-flags")
const source = task.manifest.allowedSourcePaths[0] as string
const input = taskPrompt(task)
const LIST = "List the workspace."

let builder: ServedBuilder
const threads: string[] = []
/** Each work order's manifest source digest, as written. */
const digests: Record<string, string> = {}
let repaired: string

beforeAll(async () => {
  builder = await serveBuilder(task.target)
  // The controller's half, twice: `wo-alpha` is the task's capture as `dispatch` writes it;
  // `wo-beta` is the same capture with one file more, so the two workspaces differ by a path
  // a listing can see and a digest the association records.
  const alpha = await writeBuilderManifest(task, builder.manifestDir, { workOrderId: "wo-alpha" })
  digests["wo-alpha"] = alpha.sourceDigest
  const parsed = BuilderManifestSchema.parse(JSON.parse(await readFile(alpha.path, "utf8")))
  const workspace = verifyCapturedWorkspaceDefinition(parsed.workspace)
  const extra = createSourceBundle([
    ...workspace.source.files.map((file) => ({
      path: file.path,
      bytes: new Uint8Array(Buffer.from(file.base64, "base64")),
      executable: file.executable,
    })),
    { path: "EXTRA.md", bytes: new Uint8Array(Buffer.from("one file more\n")), executable: false },
  ])
  digests["wo-beta"] = extra.digest
  await writeFile(
    join(builder.manifestDir, "wo-beta.json"),
    JSON.stringify({
      ...parsed,
      workOrderId: "wo-beta",
      workspace: { ...workspace, source: extra },
    }),
  )
  // A well-formed manifest for a target this process does not serve.
  await writeFile(
    join(builder.manifestDir, "wo-elsewhere.json"),
    JSON.stringify({ ...parsed, workOrderId: "wo-elsewhere", targetId: "devkit" }),
  )
  // The baseline bytes, from a throwaway capture of the pin under a temporary app root: the
  // same archive the manifest's workspace is built from, captured where it disturbs neither
  // the builder's nor the controller's capture directory.
  const captureRoot = await mkdtemp(join(tmpdir(), "factory-builder-baseline-"))
  try {
    repaired = await readFile(
      join(captureTarget(task, "test", { appRoot: captureRoot }).absolute, source),
      "utf8",
    )
  } finally {
    await rm(captureRoot, { recursive: true, force: true })
  }
}, 300_000)

afterAll(async () => {
  await builder?.close(threads)
})

it("drives the real builder to write the repaired source and nothing else", async () => {
  builder.aimock.addFixtures(
    script()
      .user(input)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("runBash", { command: "npm test" })
      .callsTool("writeFile", { path: source, content: `${repaired}// repaired\n` })
      .callsTool("runBash", { command: "npm test" })
      .replies("Repair complete.")
      .build(),
  )
  const threadId = await builder.createThread("wo-alpha")
  threads.push(threadId)
  const turn = await builder.runTurn(threadId, input)
  expect(turn.status).toBe(200)
  // The builder produced no interrupt, because it has no gate to park on, and every call
  // was admitted: a command off its list would have parked the thread instead.
  expect(await builder.threadStatus(threadId)).toBe("idle")
  const called = toolCallsSeen(builder.aimock)
  expect(called).toEqual(["readFile", "runBash", "writeFile", "runBash"])
  // It has no verdict channel at all.
  expect(called).not.toContain("prepareReview")
  expect(called).not.toContain("exportForReview")

  // Every tool actually ran. The bash results came out of a container that really ran the
  // fixture's own test command, and the first reproduced the documented failure, so the
  // workspace the manifest carried really is the faulty baseline. Only the first is pinned
  // to the failure: the scripted write is deliberately not a repair.
  const results = toolResults(builder.aimock)
  expect(results).toHaveLength(4)
  expect(results[0]).toContain(task.specText.split("\n")[0] as string)
  expect(results[2]).toContain(`bytes to ${source}`)
  for (const result of [results[1], results[3]]) expect(result).toContain("b4-fixture-cli-flags")
  expect(results[1]).toContain("unknown option")

  // The workspace the builder SERVED is the one the controller captured for THIS work order,
  // byte for byte: the association records the manifest's source digest.
  const installation = openWorkspaceInstallationReader(builder.appRoot)
  try {
    const record = installation.associations.get(threadId)
    // Asserted on its own: a thread with no record at all would otherwise fail as an
    // undefined digest, which reads like a capture mismatch and is not one.
    expect(record).toBeDefined()
    expect(record?.intent.sourceDigest).toBe(digests["wo-alpha"])
  } finally {
    installation.close()
  }
}, 300_000)

it("serves a second work order's own workspace from the same builder process", async () => {
  // Fresh thread, fresh script: list the workspace root, then stop.
  builder.aimock.addFixtures(
    script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
  )
  const beta = await builder.createThread("wo-beta")
  threads.push(beta)
  expect((await builder.runTurn(beta, LIST)).status).toBe(200)
  const listing = toolResults(builder.aimock)[0]
  expect(listing).toContain("EXTRA.md")
  expect(listing).toContain("TASK.md")

  // And alpha's thread, admitted first through the same resolver, keeps its own: a second
  // turn on it lists no EXTRA.md.
  const alpha = threads[0] as string
  expect((await builder.runTurn(alpha, LIST)).status).toBe(200)
  expect(toolResults(builder.aimock).at(-1)).not.toContain("EXTRA.md")

  const installation = openWorkspaceInstallationReader(builder.appRoot)
  try {
    expect(digests["wo-alpha"]).not.toBe(digests["wo-beta"])
    expect(installation.associations.get(alpha)?.intent.sourceDigest).toBe(digests["wo-alpha"])
    expect(installation.associations.get(beta)?.intent.sourceDigest).toBe(digests["wo-beta"])
  } finally {
    installation.close()
  }
}, 300_000)

it("refuses, at admission and by name, a work order with no manifest or another target's", async () => {
  for (const [workOrderId, reason] of [
    ["wo-none", "no builder manifest for wo-none"],
    ["wo-elsewhere", "is for target devkit, but this builder serves cli-flags"],
  ] as const) {
    const threadId = await builder.createThread(workOrderId)
    threads.push(threadId)
    const turn = await builder.runTurn(threadId, LIST)
    expect(turn.status).toBeGreaterThanOrEqual(400)
    expect(turn.text).toContain(reason)
    const installation = openWorkspaceInstallationReader(builder.appRoot)
    try {
      expect(installation.associations.get(threadId)).toBeUndefined()
    } finally {
      installation.close()
    }
  }
}, 300_000)
