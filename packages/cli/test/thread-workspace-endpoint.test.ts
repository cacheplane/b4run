import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import {
  inspectWorkspace,
  isCanonicalWorkspaceRoot,
  WorkspaceReadLimitError,
} from "@b4run/workspace"
import { afterEach, expect, it } from "vitest"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { isCanonicalRoot } from "../src/lib/dev/thread-workspace-http.ts"
import { withManagedWorkspaceReader } from "../src/lib/runtime/managed-workspace-reader.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const TOKEN = "Bearer endpoint-test-token"
const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  delete (globalThis as { __b4Hold?: unknown }).__b4Hold
  delete (globalThis as { __b4Started?: unknown }).__b4Started
})

/** Admits only `TOKEN`, and denies with 403 as the factory's policy does. */
const tokenPolicy = {
  fallback: (req: { headers: Readonly<Record<string, string>> }) =>
    req.headers.authorization === TOKEN
      ? { decision: "allow" as const }
      : { decision: "deny" as const, status: 403 as const },
}

async function fixture(
  options: { readonly workspaceRead?: boolean; readonly policy?: unknown } = {},
) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-inspect-endpoint-"))
  roots.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "source/main.txt": "initial",
    "src/app/edit/index.ts": "export const workflow=async (input,ctx)=>ctx.tools.edit(input)",
    "src/app/edit/tools/edit.ts":
      "export default async function edit(input:{path:string;text:string},ctx){await ctx.fs.writeFile(input.path,input.text);return {ok:true}}",
    "src/app/hold/index.ts":
      "export const workflow=async ()=>{globalThis.__b4Started?.();await globalThis.__b4Hold;return {held:true}}",
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: { source: { directory: "source", include: ["main.txt"] } },
      ...(options.workspaceRead === false ? {} : { workspaceRead: "http" as const }),
    },
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config,
    threadAccess: (options.policy ?? tokenPolicy) as never,
  })
  handlers.push(handler)
  const call = (
    method: string,
    path: string,
    body?: unknown,
    authorization: string | null = TOKEN,
  ) =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authorization === null ? {} : { authorization }),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    )
  const createThread = async () =>
    ((await (await call("POST", "/threads", { metadata: {} })).json()) as { thread_id: string })
      .thread_id
  const run = (threadId: string, route: string, input = {}) =>
    call("POST", `/threads/${threadId}/runs/wait`, { route, input })
  const inspect = (threadId: string, body: unknown = {}, authorization: string | null = TOKEN) =>
    call("POST", `/threads/${threadId}/workspace/inspect`, body, authorization)
  return { appRoot, physical, handler, call, createThread, run, inspect }
}

it("answers what the local reader reads, on an idle thread, with the recorded digests", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  expect(
    (await f.run(threadId, "/edit#workflow", { path: "draft/out.txt", text: "made" })).status,
  ).toBe(200)
  const response = await f.inspect(threadId)
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    threadId: string
    sourceDigest: string
    intentDigest: string
    inspection: unknown
  }
  const local = await withManagedWorkspaceReader(
    {
      appRoot: f.appRoot,
      provider: f.physical.provider,
      threadId,
      signal: new AbortController().signal,
    },
    (reader) => inspectWorkspace(reader, {}),
  )
  expect(body.inspection).toEqual(JSON.parse(JSON.stringify(local)))
  const installation = openWorkspaceInstallationReader(f.appRoot)
  const intent = installation.associations.get(threadId)?.intent
  installation.close()
  expect(body).toMatchObject({
    threadId,
    sourceDigest: intent?.sourceDigest,
    intentDigest: intent?.digest,
  })
})

it("holds the run slot: 409 while a run is in flight, and a run cannot start during a read", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  let release!: () => void
  const hold = globalThis as { __b4Hold?: Promise<void>; __b4Started?: () => void }
  hold.__b4Hold = new Promise((resolve) => {
    release = resolve
  })
  // The route reports that it is running (so the run holds the slot) before the read is tried:
  // polling instead would let an early read take the slot and turn the run into the 409.
  const started = new Promise<void>((resolve) => {
    hold.__b4Started = resolve
  })
  const running = f.run(threadId, "/hold#workflow")
  await started
  const busy = await f.inspect(threadId)
  expect(busy.status).toBe(409)
  expect(await busy.json()).toMatchObject({ error: { details: { code: "run_in_flight" } } })
  release()
  expect((await running).status).toBe(200)
  expect((await f.inspect(threadId)).status).toBe(200)
})

it("a run and a delete are refused while a read holds the slot, and a cancel aborts the read", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  const open = f.physical.workspaces.openWorkspaceReader?.bind(f.physical.workspaces)
  if (!open) throw new Error("the fixture reads")
  let opened!: () => void
  const readerOpened = new Promise<void>((resolve) => {
    opened = resolve
  })
  let proceed!: () => void
  const gate = new Promise<void>((resolve) => {
    proceed = resolve
  })
  let readSignal: AbortSignal | undefined
  f.physical.workspaces.openWorkspaceReader = async (input) => {
    readSignal = input.signal
    opened()
    await gate
    return open(input)
  }
  const reading = f.inspect(threadId)
  await readerOpened
  const run = await f.run(threadId, "/edit#workflow", { path: "b.txt", text: "b" })
  expect(run.status).toBe(409)
  expect(await run.json()).toMatchObject({ error: { details: { code: "run_in_flight" } } })
  const deleted = await f.call("DELETE", `/threads/${threadId}`)
  expect(deleted.status).toBe(409)
  proceed()
  expect((await reading).status).toBe(200)
  // The slot is released with the read: the next run goes through.
  expect((await f.run(threadId, "/edit#workflow", { path: "b.txt", text: "b" })).status).toBe(200)

  // A cancel through the registry aborts the read's signal.
  let proceedAgain!: () => void
  const gateAgain = new Promise<void>((resolve) => {
    proceedAgain = resolve
  })
  let openedAgain!: () => void
  const readerOpenedAgain = new Promise<void>((resolve) => {
    openedAgain = resolve
  })
  f.physical.workspaces.openWorkspaceReader = async (input) => {
    readSignal = input.signal
    openedAgain()
    await gateAgain
    input.signal.throwIfAborted()
    return open(input)
  }
  const cancelled = f.inspect(threadId)
  await readerOpenedAgain
  expect((await f.call("POST", `/threads/${threadId}/cancel`, {})).status).toBeLessThan(300)
  expect(readSignal?.aborted).toBe(true)
  proceedAgain()
  const aborted = await cancelled
  expect(aborted.status).toBe(409)
  expect(await aborted.json()).toMatchObject({ error: { details: { code: "read_cancelled" } } })
})

it("403 without the token, and without a policy's allow the thread is not disclosed", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  expect((await f.inspect(threadId, {}, null)).status).toBe(403)
  expect((await f.inspect(threadId, {}, "Bearer wrong")).status).toBe(403)
  const defaultDeny = await fixture({ policy: { fallback: () => ({ decision: "deny" }) } })
  expect((await defaultDeny.inspect("any-thread", {}, null)).status).toBe(404)
})

it("refuses a root with `..` by name, and names an absent root", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  const traversal = await f.inspect(threadId, { root: "../etc" })
  expect(traversal.status).toBe(400)
  expect(JSON.stringify(await traversal.json())).toContain("../etc")
  const absent = await f.inspect(threadId, { root: "draft" })
  expect(absent.status).toBe(422)
  expect(await absent.json()).toMatchObject({
    error: { details: { code: "workspace_root_missing", root: "draft", kind: "absent" } },
  })
})

it("is not served unless the app opts in, and never tells an unauthorized caller which", async () => {
  const off = await fixture({ workspaceRead: false })
  const threadId = await off.createThread()
  const response = await off.inspect(threadId)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { message: "Not found" } })
  // Unauthorized: the gate's answer, on or off alike, and the body is never read.
  const on = await fixture()
  const onThread = await on.createThread()
  for (const [f, id] of [
    [off, threadId],
    [on, onThread],
  ] as const) {
    const denied = await f.inspect(id, "x".repeat(200 * 1024), null)
    expect(denied.status).toBe(403)
    // A streamed body the reader never pulls: the gate answered without reading it.
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array(1024))
        },
      },
      { highWaterMark: 0 },
    )
    const streamed = await f.handler.fetch(
      new Request(`http://localhost/threads/${id}/workspace/inspect`, {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    )
    expect(streamed.status).toBe(403)
    expect(pulls).toBe(0)
  }
})

it("agrees with @b4run/workspace on which roots are canonical", () => {
  for (const root of [
    "draft",
    "a/b",
    "..",
    "a/../b",
    "/a",
    "a/",
    "a//b",
    "",
    ".",
    "a\\b",
    "x\u0000y",
    "é/ü",
  ])
    expect([root, isCanonicalRoot(root)]).toEqual([root, isCanonicalWorkspaceRoot(root)])
})

it("answers 409 workspace_changed when the workspace changes under the read", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  const open = f.physical.workspaces.openWorkspaceReader?.bind(f.physical.workspaces)
  if (!open) throw new Error("the fixture reads")
  f.physical.workspaces.openWorkspaceReader = async (input) => {
    const reader = await open(input)
    return {
      ...reader,
      filesystem: {
        ...reader.filesystem,
        readBinaryFile: async (path: string) => {
          throw new WorkspaceReadLimitError(
            `readBinaryFile ${path}: content exceeds maxBytes (1).`,
            path,
            1,
          )
        },
      },
    }
  }
  const response = await f.inspect(threadId)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_changed" } } })
})

it("names a thread that has not run, and a thread that does not exist", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  expect(await (await f.inspect(threadId)).json()).toMatchObject({
    error: { details: { code: "workspace_not_found" } },
  })
  const missing = await f.inspect("no-such-thread")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { details: { code: "thread_not_found" } } })
})

it("filters ignorePrefixes, and refuses unknown options, limits over the caps and oversized bodies", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "dist/out.js", text: "built" })
  const filtered = (await (await f.inspect(threadId, { ignorePrefixes: ["dist/"] })).json()) as {
    inspection: { files: Record<string, string> }
  }
  expect(Object.keys(filtered.inspection.files)).toEqual(["main.txt"])
  expect((await f.inspect(threadId, { rot: "draft" })).status).toBe(400)
  expect((await f.inspect(threadId, { maxTotalBytes: 64 * 1024 * 1024 })).status).toBe(400)
  expect((await f.inspect(threadId, "x".repeat(65 * 1024))).status).toBe(413)
})
