import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ServeRuntimeHandle, serveRuntime } from "@b4run/cli"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { type Aimock, createAimock, script } from "@b4run/testing"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { afterAll, beforeAll, expect, it } from "vitest"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { type CapturedDrafterHandoff, DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import { createHttpWorkerClient, type WorkerClient } from "../src/lib/worker/client.ts"
import { isolatedDrafter } from "./isolated-drafter.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"
import { expectOnlyTheTokenAdmitted, WORKER_AUTHORIZATION } from "./worker-token-probe.ts"

/**
 * The drafter's resolver, served: one drafter process, two work orders, two threads, and
 * each thread sees its own capture and no other. The captures are built here with the
 * framework's own capture over two tiny trees (the second holds one file more), and handed
 * over the drafter's port exactly as `intake` does (uploaded, then the thread created naming
 * the source, with the handoff in `factoryDrafter`); the drafter is booted from a private
 * copy (`isolatedDrafter`). The lane lives in the controller's tests so the drafter package
 * needs no test-only dependencies of its own; nothing here is imported into the drafter.
 * `drafter-end-to-end.integration.test.ts` is where the real wide capture meets this same
 * resolver. A thread created with no staged workspace, or another one than its handoff names,
 * is refused at admission, by name, in the run's error.
 *
 * Requires Docker and the base image pulled by digest (`docker pull` of the literal in the
 * drafter's `src/drafter-image.ts`). Runs only under `test:sandbox`.
 */

const PROMPT = "List the repository."
/** What the served drafter reads from the process: restored afterwards. */
const ENV = [
  "FACTORY_DRAFTER_MANIFEST_DIR",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "B4_PERMISSIONS_MODE",
  "FACTORY_WORKER_TOKEN",
] as const

let aimock: Aimock
let root: string
let server: ServeRuntimeHandle
let client: WorkerClient
let scratch: string
const digests: Record<string, string> = {}
const captured: Record<string, CapturedDrafterHandoff> = {}
const previousEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {}

/** A capture for `workOrderId`: the repository under `repo/`, holding `files`, no baseline. */
async function capture(workOrderId: string, files: Record<string, string>) {
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
  captured[workOrderId] = {
    workspace,
    handoff: DrafterHandoffSchema.parse({
      version: 2,
      workOrderId,
      workspace: stagedReferenceOf(workspace),
    }),
  }
}

/** As `intake` hands a thread its workspace: upload, then create naming it, with the handoff. */
async function handOff(
  workOrderId: string,
  workspace: CapturedWorkspaceDefinition | null = (captured[workOrderId] as CapturedDrafterHandoff)
    .workspace,
): Promise<string> {
  const handoff = (captured[workOrderId] as CapturedDrafterHandoff).handoff
  if (workspace !== null) await client.uploadSource(workspace.source)
  return client.createThread(
    { factoryWorkOrderId: workOrderId, factoryStage: "intake", factoryDrafter: handoff },
    ...(workspace !== null ? [stagedReferenceOf(workspace)] : []),
  )
}

async function runTurn(threadId: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.url}/threads/${encodeURIComponent(threadId)}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json", ...WORKER_AUTHORIZATION },
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
  scratch = await mkdtemp(join(tmpdir(), "drafter-resolver-"))
  root = await isolatedDrafter()
  await capture("wo-alpha", { "README.md": "# alpha\n" })
  await capture("wo-beta", { "README.md": "# beta\n", "EXTRA.md": "one file more\n" })
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
  // its model: set before the app boots in this process. The retired manifest directory is
  // unset: the drafter refuses to boot while it is set.
  delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = "test"
  process.env.FACTORY_WORKER_TOKEN = TEST_WORKER_TOKEN
  server = await serveRuntime({ appRoot: root, host: "127.0.0.1", port: 0 })
  client = createHttpWorkerClient(server.url, { token: TEST_WORKER_TOKEN })
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

it("answers no thread endpoint without the worker token, and 403 with a wrong one", async () => {
  // Created with the token, as the controller does; no turn runs, so no sandbox is acquired.
  const threadId = await handOff("wo-alpha")
  await expectOnlyTheTokenAdmitted(server.url, threadId, "/intake#agent")
})

it("serves each work order's own capture to its own thread", async () => {
  expect(digests["wo-alpha"]).not.toBe(digests["wo-beta"])
  const alpha = await handOff("wo-alpha")
  const beta = await handOff("wo-beta")
  expect(alpha).not.toBe(beta)
  expect((await runTurn(alpha)).status).toBe(200)
  expect((await runTurn(beta)).status).toBe(200)

  // Admitted through the resolver: the association each thread carries names the digest of
  // the source staged for ITS work order.
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

it("refuses, by name in the run's error, a thread with no staged workspace or another one", async () => {
  for (const [workspace, reason] of [
    [null, "work order wo-alpha's intake thread was created without a staged workspace"],
    [
      (captured["wo-beta"] as CapturedDrafterHandoff).workspace,
      "is not the one work order wo-alpha names",
    ],
  ] as const) {
    const orphan = await handOff("wo-alpha", workspace)
    const result = await runTurn(orphan)
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.text).toContain(reason)
    const store = openWorkspaceInstallationReader(root)
    try {
      expect(store.associations.get(orphan)).toBeUndefined()
    } finally {
      store.close()
    }
  }
}, 300_000)
