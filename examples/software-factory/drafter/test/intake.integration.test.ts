import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ServeRuntimeHandle, serveRuntime } from "@b4run/cli"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { type Aimock, createAimock, script } from "@b4run/testing"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { afterAll, beforeAll, expect, it } from "vitest"
import { isolatedDrafter } from "./isolated-drafter.ts"

/**
 * The resolver, served: one drafter process, two work orders, two threads, and each thread
 * sees its own capture and no other. The manifests are built here with the framework's own
 * capture over two tiny trees (the second holds one file more), in the exact shape the
 * controller writes; the controller's own lane
 * (`controller/test/drafter-end-to-end.integration.test.ts`) is where the real writer and
 * the real wide capture meet this same resolver. A third thread whose work order has no
 * manifest is refused at admission, by name, in the run's error.
 *
 * Requires Docker and the base image pulled by digest (`docker pull` of the literal in
 * `src/drafter-image.ts`). Runs only under `test:sandbox`.
 */

const PROMPT = "List the repository."
/** What the served drafter reads from the process: restored afterwards. */
const ENV = [
  "FACTORY_DRAFTER_MANIFEST_DIR",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "B4_PERMISSIONS_MODE",
] as const

let aimock: Aimock
let root: string
let manifestDir: string
let server: ServeRuntimeHandle
let scratch: string
const digests: Record<string, string> = {}
const previousEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {}

/** A manifest for `workOrderId`: the repository under `repo/`, holding `files`, no baseline. */
async function writeManifest(workOrderId: string, files: Record<string, string>) {
  const tree = join(scratch, workOrderId)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(tree, "repo", path, ".."), { recursive: true })
    await writeFile(join(tree, "repo", path), text)
  }
  const workspace = await captureWorkspaceDefinition(scratch, {
    source: { directory: workOrderId, include: Object.keys(files).map((p) => `repo/${p}`) },
    environmentLinks: [],
  })
  digests[workOrderId] = workspace.source.digest
  await writeFile(
    join(manifestDir, `${workOrderId}.json`),
    JSON.stringify({ version: 1, workOrderId, workspace }),
  )
}

async function createThread(workOrderId: string): Promise<string> {
  const response = await fetch(`${server.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata: { factoryWorkOrderId: workOrderId } }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { thread_id: string }).thread_id
}

async function runTurn(threadId: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.url}/threads/${encodeURIComponent(threadId)}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      route: "/intake#agent",
      input: { messages: [{ role: "user", content: PROMPT }] },
    }),
  })
  return { status: response.status, text: await response.text() }
}

/** The `listDir repo/` result the model was handed on `threadId`'s turn, from aimock's journal. */
function listingSeenBy(turn: number): string {
  const request = aimock.getRequests()[turn]
  const tool = (request?.body?.messages ?? []).find((m) => m.role === "tool")
  return String(tool?.content)
}

beforeAll(async () => {
  for (const key of ENV) previousEnv[key] = process.env[key]
  delete process.env.B4_PERMISSIONS_MODE
  scratch = await mkdtemp(join(tmpdir(), "drafter-intake-"))
  root = await isolatedDrafter()
  manifestDir = join(root, ".factory", "manifests")
  await mkdir(manifestDir, { recursive: true })
  await writeManifest("wo-alpha", { "README.md": "# alpha\n" })
  await writeManifest("wo-beta", { "README.md": "# beta\n", "EXTRA.md": "one file more\n" })
  // Every thread's turn is the same: list `repo/`, then say so. Fresh threads, so the
  // script's turn counts hold for each.
  aimock = await createAimock({
    fixtures: script()
      .user(PROMPT)
      .callsTool("listDir", { path: "repo/" })
      .replies("Listed.")
      .build(),
  })
  // Read by `b4.config.ts` at module load and by the model layer when the route first builds
  // its model: set before the app boots in this process.
  process.env.FACTORY_DRAFTER_MANIFEST_DIR = manifestDir
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = "test"
  server = await serveRuntime({ appRoot: root, host: "127.0.0.1", port: 0 })
}, 300_000)

afterAll(async () => {
  await server?.close()
  await aimock?.close()
  if (root) await rm(root, { recursive: true, force: true })
  if (scratch) await rm(scratch, { recursive: true, force: true })
  for (const key of ENV) {
    const previous = previousEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

it("serves each work order's own capture to its own thread", async () => {
  expect(digests["wo-alpha"]).not.toBe(digests["wo-beta"])
  const alpha = await createThread("wo-alpha")
  const beta = await createThread("wo-beta")
  expect(alpha).not.toBe(beta)
  expect((await runTurn(alpha)).status).toBe(200)
  expect((await runTurn(beta)).status).toBe(200)

  // Admitted through the resolver: the association each thread carries names the digest of
  // the manifest written for ITS work order.
  const store = openWorkspaceInstallationReader(root)
  try {
    expect(store.associations.get(alpha)?.intent.sourceDigest).toBe(digests["wo-alpha"])
    expect(store.associations.get(beta)?.intent.sourceDigest).toBe(digests["wo-beta"])
  } finally {
    store.close()
  }
  // And the tools saw it: the listing handed back on beta's turn has the file alpha's lacks.
  expect(aimock.getRequests()).toHaveLength(4)
  expect(listingSeenBy(1)).toContain("README.md")
  expect(listingSeenBy(1)).not.toContain("EXTRA.md")
  expect(listingSeenBy(3)).toContain("EXTRA.md")
}, 300_000)

it("refuses a thread whose work order has no manifest, by name, in the run's error", async () => {
  const orphan = await createThread("wo-none")
  const result = await runTurn(orphan)
  expect(result.status).not.toBe(200)
  expect(result.text).toContain("no drafter manifest for wo-none")
  const store = openWorkspaceInstallationReader(root)
  try {
    expect(store.associations.get(orphan)).toBeUndefined()
  } finally {
    store.close()
  }
}, 300_000)
