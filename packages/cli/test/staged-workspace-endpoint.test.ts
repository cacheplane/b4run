import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { seedB4Config } from "@b4run/core"
import {
  createThreadsStore,
  openWorkspaceInstallationReader,
  type ThreadsStore,
} from "@b4run/sqlite-storage"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, expect, it, vi } from "vitest"
import { threadSandboxArtifact } from "../src/lib/build/workspace-artifact.ts"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { stagedWorkspaceField } from "../src/lib/dev/thread-workspace-http.ts"
import { resolveSandboxManager } from "../src/lib/runtime/resolve-sandbox.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const TOKEN = "Bearer staged-test-token"
const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const source = (text: string) =>
  createSourceBundle([
    { path: "main.txt", bytes: new TextEncoder().encode(text), executable: false },
  ])
type Bundle = ReturnType<typeof source>

async function appRootWith(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-endpoint-"))
  roots.push(appRoot)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  return appRoot
}

const APP_FILES = {
  "package.json": '{"type":"module"}',
  "b4.config.ts": "export default {}",
  "workspace/.keep": "",
  "src/app/read/index.ts": "export const workflow=async (input,ctx)=>ctx.tools.read(input)",
  "src/app/read/tools/read.ts":
    "export default async function read(input:{path:string},ctx){return {text:await ctx.fs.readFile(input.path)}}",
}

async function fixture(
  options: {
    readonly stagedWorkspaces?: unknown
    readonly attachRefusedOnce?: boolean
    readonly mode?: "thread" | "workspace"
    /** Served to a thread created without a staged workspace, instead of refusing it. */
    readonly fallbackSource?: Bundle
    /** Replaces the fixture's token policy. */
    readonly policy?: unknown
  } = {},
) {
  const appRoot = await appRootWith(APP_FILES)
  const physical = managedProviderFixture()
  const resolved: { threadId: string; digest: string | undefined }[] = []
  const decisions: { action: string; operation: string; requestedWorkspace: unknown }[] = []
  /** Thread ids the create recheck saw: the rows this runtime wrote. */
  const written: string[] = []
  const decide = (thread: { threadId: string; staged?: { source: { digest: string } } }) => {
    resolved.push({ threadId: thread.threadId, digest: thread.staged?.source.digest })
    if (!thread.staged && options.fallbackSource)
      return { version: 1 as const, source: options.fallbackSource, environmentLinks: [] }
    if (!thread.staged) throw new Error("this app serves only staged workspaces")
    return thread.staged
  }
  const config = {
    sandbox: {
      provider: physical.provider,
      stagedWorkspaces: options.stagedWorkspaces ?? true,
      ...(options.mode === "workspace"
        ? { workspace: async (thread: never) => decide(thread) }
        : { thread: async (thread: never) => ({ workspace: decide(thread) }) }),
    },
  }
  const threadAccess = {
    fallback: (req: {
      action: string
      operation: string
      threadId: string | undefined
      headers: Readonly<Record<string, string>>
      requestedWorkspace: unknown
    }) => {
      decisions.push({
        action: req.action,
        operation: req.operation,
        requestedWorkspace: req.requestedWorkspace,
      })
      if (req.action === "update" && req.operation === "thread.create" && req.threadId)
        written.push(req.threadId)
      return req.headers.authorization === TOKEN
        ? { decision: "allow" as const }
        : { decision: "deny" as const, status: 403 as const }
    },
  }
  // A threads store the test can reach: to fail a delete, or to remove a row behind the
  // runtime's back.
  const store = createThreadsStore({ path: join(appRoot, "threads-under-test.sqlite") })
  let failNextDelete = false
  const threadsStore = new Proxy(store, {
    get(target, key) {
      if (key === "deleteThread")
        return async (id: string) => {
          if (failNextDelete) {
            failNextDelete = false
            throw new Error("the threads store is unavailable")
          }
          return target.deleteThread(id)
        }
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as ThreadsStore
  const boot = async () => {
    // To race a reclaim against a create, a test hands the runtime a manager whose next
    // attach finds the source gone, exactly as a reclaim between the check and the attach would.
    let sandboxManager: Awaited<ReturnType<typeof resolveSandboxManager>> | undefined
    if (options.attachRefusedOnce) {
      seedB4Config(appRoot, config as never)
      sandboxManager = await resolveSandboxManager(appRoot)
      if (!sandboxManager) throw new Error("the fixture configures a sandbox")
      vi.spyOn(sandboxManager, "attachStagedWorkspace").mockReturnValueOnce({
        ok: false,
        code: "workspace_source_not_held",
        message: "Workspace source was reclaimed: upload it again",
      })
    }
    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: config as never,
      threadAccess: (options.policy ?? threadAccess) as never,
      threadsStore,
      ...(sandboxManager ? { sandboxManager } : {}),
    })
    handlers.push(handler)
    return handler
  }
  let handler = await boot()
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
  return {
    appRoot,
    resolved,
    decisions,
    written,
    store,
    call,
    raw: (request: Request) => handler.fetch(request),
    failNextDelete() {
      failNextDelete = true
    },
    async restart() {
      await handler.close()
      handlers.splice(handlers.indexOf(handler), 1)
      handler = await boot()
    },
    upload: (bundle: Bundle, digest = bundle.digest, authorization: string | null = TOKEN) =>
      call("PUT", `/workspace/sources/${digest}`, bundle, authorization),
    create: (workspace: unknown, authorization: string | null = TOKEN) =>
      call("POST", "/threads", { metadata: { purpose: "test" }, workspace }, authorization),
    read: (threadId: string) =>
      call("POST", `/threads/${threadId}/runs/wait`, {
        route: "/read#workflow",
        input: { path: "main.txt" },
      }),
  }
}

/** Rows created: every create that reached the store is followed by its `update` recheck. */
const rowsCreated = (decisions: { action: string; operation: string }[]) =>
  decisions.filter((d) => d.action === "update" && d.operation === "thread.create").length

/** The stored payload of a held source, read straight from the installation database. */
function storedPayload(appRoot: string, digest: string): string | undefined {
  const db = new DatabaseSync(join(appRoot, ".b4", "workspaces", "state.sqlite"), {
    readOnly: true,
  })
  try {
    const row = db.prepare("SELECT payload FROM workspace_sources WHERE digest=?").get(digest)
    return row ? String(row.payload) : undefined
  } finally {
    db.close()
  }
}

for (const mode of ["thread", "workspace"] as const)
  it(`uploads, creates, and serves the staged workspace at the first run, recorded by digest (sandbox.${mode})`, async () => {
    const f = await fixture({ mode })
    const bundle = source("staged bytes")
    const first = await f.upload(bundle)
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ digest: bundle.digest, status: "created" })
    // Exactly the verified bytes are stored, under exactly their own digest.
    expect(storedPayload(f.appRoot, bundle.digest)).toBe(JSON.stringify(bundle))
    const again = await f.upload(bundle)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ digest: bundle.digest, status: "held" })
    const created = await f.create({ sourceDigest: bundle.digest })
    expect(created.status).toBe(200)
    const threadId = ((await created.json()) as { thread_id: string }).thread_id
    // The digest lives in the installation, never in client-visible metadata.
    const row = await f.store.getThread(threadId)
    expect(JSON.stringify(row?.metadata)).not.toContain(bundle.digest)
    const run = await f.read(threadId)
    expect(run.status).toBe(200)
    expect(JSON.stringify(await run.json())).toContain("staged bytes")
    expect(f.resolved).toEqual([{ threadId, digest: bundle.digest }])
    const installation = openWorkspaceInstallationReader(f.appRoot)
    expect(installation.associations.get(threadId)?.intent.sourceDigest).toBe(bundle.digest)
    installation.close()
    await f.restart()
    expect((await f.read(threadId)).status).toBe(200)
    expect(f.resolved).toHaveLength(1)
  })

it("refuses a create naming a digest it does not hold, before any thread row", async () => {
  const f = await fixture()
  const response = await f.create({ sourceDigest: "a".repeat(64) })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({
    error: { details: { code: "workspace_source_not_held" } },
  })
  expect(rowsCreated(f.decisions)).toBe(0)
})

it("refuses a body whose digest differs from the path, a forged digest, and a malformed bundle", async () => {
  const f = await fixture()
  const bundle = source("x")
  const other = source("y")
  // A valid bundle, under another bundle's digest: never kept under the path's.
  const mismatch = await f.upload(bundle, other.digest)
  expect(mismatch.status).toBe(400)
  expect(await mismatch.json()).toMatchObject({ error: { details: { code: "digest_mismatch" } } })
  // A body that claims the path's digest for files that are not its content.
  const forged = await f.call("PUT", `/workspace/sources/${other.digest}`, {
    ...bundle,
    digest: other.digest,
  })
  expect(forged.status).toBe(422)
  expect(await forged.json()).toMatchObject({
    error: { details: { code: "workspace_source_invalid" } },
  })
  const invalid = await f.call("PUT", `/workspace/sources/${bundle.digest}`, {
    ...bundle,
    files: [{ path: "../x", base64: "", executable: false }],
  })
  expect(invalid.status).toBe(422)
  expect((await f.call("PUT", `/workspace/sources/${bundle.digest}`, "{not json")).status).toBe(400)
  expect((await f.call("PUT", "/workspace/sources/not-a-digest", bundle)).status).toBe(400)
  for (const digest of [bundle.digest, other.digest])
    expect(storedPayload(f.appRoot, digest)).toBeUndefined()
})

it("403 without the token, for the upload and for the create, before anything is kept", async () => {
  const f = await fixture()
  const bundle = source("x")
  expect((await f.upload(bundle, bundle.digest, null)).status).toBe(403)
  expect(storedPayload(f.appRoot, bundle.digest)).toBeUndefined()
  expect((await f.create({ sourceDigest: bundle.digest }, null)).status).toBe(403)
  expect(rowsCreated(f.decisions)).toBe(0)
  expect((await f.create({ sourceDigest: bundle.digest })).status).toBe(422)
})

it("shows the policy the workspace an upload stages and the whole reference a create names", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const reference = {
    sourceDigest: bundle.digest,
    environmentLinks: [{ path: "deps", target: "/opt/deps" }],
    baseline: "git",
  }
  expect((await f.create(reference)).status).toBe(200)
  expect((await f.call("POST", "/threads", { metadata: {} })).status).toBe(200)
  expect(f.decisions).toContainEqual({
    action: "create",
    operation: "workspace.source.put",
    requestedWorkspace: { sourceDigest: bundle.digest },
  })
  // The create sees who uploaded it: nobody with a stamp, here.
  const chosen = { ...reference, uploadedBy: [] }
  expect(f.decisions).toContainEqual({
    action: "create",
    operation: "thread.create",
    requestedWorkspace: chosen,
  })
  expect(
    f.decisions.filter((d) => d.operation === "thread.create" && d.action === "create"),
  ).toEqual([
    { action: "create", operation: "thread.create", requestedWorkspace: chosen },
    { action: "create", operation: "thread.create", requestedWorkspace: undefined },
  ])
  expect(f.decisions.filter((d) => d.action === "update").map((d) => d.requestedWorkspace)).toEqual(
    [undefined, undefined],
  )
})

it("refuses a workspace the app does not accept instead of ignoring it, and hides the option from the unauthorized", async () => {
  const off = await fixture({ stagedWorkspaces: false })
  const response = await off.create({ sourceDigest: "a".repeat(64) })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { details: { code: "workspace_not_accepted" } },
  })
  expect((await off.upload(source("x"))).status).toBe(404)
  expect(rowsCreated(off.decisions)).toBe(0)
  // Without the token, off and on answer alike: the gate's 403, even for an upload over
  // the on app's limit, whose body is never read.
  const on = await fixture({ stagedWorkspaces: { maxUploadBytes: 1024 } })
  const big = source("x".repeat(200 * 1024))
  for (const f of [off, on]) {
    expect((await f.upload(big, undefined, null)).status).toBe(403)
    expect((await f.create({ sourceDigest: "a".repeat(64) }, null)).status).toBe(403)
  }
  // A malformed field is a 400 whether the option is on or off.
  for (const f of [off, on]) expect((await f.create({ sourceDigest: "not-hex" })).status).toBe(400)
  // And an app without the option keeps reading create bodies unbounded, as before.
  expect(
    (await off.call("POST", "/threads", { metadata: { pad: "x".repeat(2 * 1024 * 1024) } })).status,
  ).toBe(200)
})

it("takes one upload at a time and caps what is staged", async () => {
  const f = await fixture({ stagedWorkspaces: { maxStagedBytes: 4096 } })
  const [a, b] = [source("a".repeat(1500)), source("b".repeat(1500))]
  const both = await Promise.all([f.upload(a), f.upload(b)])
  expect(both.map((r) => r.status).sort()).toEqual([201, 429])
  const refused = both.find((r) => r.status === 429)
  expect(refused?.headers.get("retry-after")).toBe("1")
  expect(await refused?.json()).toMatchObject({ error: { details: { code: "upload_in_flight" } } })
  const later = await f.upload(both[0]?.status === 201 ? b : a)
  expect(later.status).toBe(507)
  expect(await later.json()).toMatchObject({
    error: { details: { code: "staged_quota_exceeded" } },
  })
  // The slot is free again after a refusal and after a success.
  expect((await f.upload(both[0]?.status === 201 ? a : b)).status).toBe(200)
})

it("deletes the thread row when its source is reclaimed between the check and the attach", async () => {
  const f = await fixture({ attachRefusedOnce: true })
  const bundle = source("x")
  await f.upload(bundle)
  const response = await f.create({ sourceDigest: bundle.digest })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: { details: { code: "workspace_source_not_held" } },
  })
  expect(f.written).toHaveLength(1)
  expect(await f.store.getThread(f.written[0] as string)).toBeUndefined()
  expect((await f.call("GET", `/threads/${f.written[0]}`)).status).toBe(404)
})

it("forgets a deleted thread's staged workspace first: a thread reusing the id gets none", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const threadId = (
    (await (await f.create({ sourceDigest: bundle.digest })).json()) as { thread_id: string }
  ).thread_id
  expect((await f.call("DELETE", `/threads/${threadId}`)).status).toBe(204)
  // A run endpoint creates a thread under a client-chosen id: this one.
  await f.read(threadId)
  expect(f.resolved).toEqual([{ threadId, digest: undefined }])
})

it("fails closed when the delete fails after forgetting: the surviving thread has no staged workspace", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const threadId = (
    (await (await f.create({ sourceDigest: bundle.digest })).json()) as { thread_id: string }
  ).thread_id
  f.failNextDelete()
  expect((await f.call("DELETE", `/threads/${threadId}`)).status).toBe(500)
  expect(await f.store.getThread(threadId)).toBeDefined()
  await f.read(threadId)
  expect(f.resolved).toEqual([{ threadId, digest: undefined }])
})

it("sweeps at boot the staged workspace of a thread whose row is gone", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const threadId = (
    (await (await f.create({ sourceDigest: bundle.digest })).json()) as { thread_id: string }
  ).thread_id
  // Removed behind the runtime's back (or a crash between the detach and the row delete).
  await f.store.deleteThread(threadId)
  await f.restart()
  await f.read(threadId)
  expect(f.resolved).toEqual([{ threadId, digest: undefined }])
})

it("bounds the upload and the create", async () => {
  const f = await fixture({ stagedWorkspaces: { maxUploadBytes: 1024 } })
  const big = source("x".repeat(4096))
  const upload = await f.upload(big)
  expect(upload.status).toBe(413)
  expect(await upload.json()).toMatchObject({ error: { details: { code: "payload_too_large" } } })
  expect(
    (await f.call("POST", "/threads", { metadata: { pad: "x".repeat(1024 * 1024) } })).status,
  ).toBe(413)
  // The upload slot was released by the refusal.
  expect((await f.upload(source("small"))).status).toBe(201)
})

it("refuses a definition the held source cannot make: a link over a file", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const response = await f.create({
    sourceDigest: bundle.digest,
    environmentLinks: [{ path: "main.txt", target: "/x" }],
  })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_invalid" } } })
  expect(rowsCreated(f.decisions)).toBe(0)
})

it("a built app's embedded policy satisfies the option and gates the upload; a manifest with none is refused", async () => {
  // No src/thread-access.ts on disk: a built app's policy is the one in its manifest (#839).
  const appRoot = await appRootWith(APP_FILES)
  const config = {
    sandbox: {
      provider: managedProviderFixture().provider,
      stagedWorkspaces: true,
      thread: async () => {
        throw new Error("never admitted here")
      },
    },
  }
  const artifact = threadSandboxArtifact()
  await expect(
    createRuntimeFetchHandler({
      appRoot,
      config: config as never,
      modules: { routes: [], workspace: artifact } as never,
    }),
  ).rejects.toThrow(/sandbox.stagedWorkspaces .* no thread-access policy/)
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config: config as never,
    modules: {
      routes: [],
      workspace: artifact,
      threadAccess: { fallback: () => ({ decision: "deny", status: 403 }) },
    } as never,
    threadAccessExpected: true,
  })
  handlers.push(handler)
  const bundle = source("x")
  const response = await handler.fetch(
    new Request(`http://localhost/workspace/sources/${bundle.digest}`, {
      method: "PUT",
      body: JSON.stringify(bundle),
    }),
  )
  expect(response.status).toBe(403)
})

it("shape-checks the workspace field onto fresh, frozen objects", () => {
  const digest = "a".repeat(64)
  const input = { sourceDigest: digest, environmentLinks: [{ path: "a", target: "/b" }] }
  const field = stagedWorkspaceField(input)
  expect(field).toEqual({ ok: true, reference: input })
  if (!field.ok) return
  expect(field.reference).not.toBe(input)
  expect(Object.isFrozen(field.reference)).toBe(true)
  expect(Object.isFrozen(field.reference.environmentLinks)).toBe(true)
  expect(Object.isFrozen(field.reference.environmentLinks?.[0])).toBe(true)
  for (const value of [
    null,
    [],
    "x",
    {},
    { sourceDigest: digest.toUpperCase() },
    { sourceDigest: digest, extra: true },
    { sourceDigest: digest, baseline: "svn" },
    { sourceDigest: digest, environmentLinks: {} },
    { sourceDigest: digest, environmentLinks: [{ path: "a" }] },
    { sourceDigest: digest, environmentLinks: [{ path: "a", target: "/b", x: 1 }] },
    { sourceDigest: digest, environmentLinks: [{ path: 1, target: "/b" }] },
    { sourceDigest: digest, environmentLinks: Array(1025).fill({ path: "a", target: "/b" }) },
  ])
    expect(stagedWorkspaceField(value).ok).toBe(false)
  // Inherited keys are not the client's.
  expect(stagedWorkspaceField(Object.create({ sourceDigest: digest })).ok).toBe(false)
})

it("refuses a create naming a source an admission stored for another thread", async () => {
  const secret = source("another thread's workspace")
  const f = await fixture({ fallbackSource: secret })
  // Thread A is created without a staged workspace; its admission stores `secret`.
  const a = (
    (await (await f.call("POST", "/threads", { metadata: {} })).json()) as {
      thread_id: string
    }
  ).thread_id
  expect((await f.read(a)).status).toBe(200)
  const installation = openWorkspaceInstallationReader(f.appRoot)
  const digest = installation.associations.get(a)?.intent.sourceDigest
  installation.close()
  expect(digest).toBe(secret.digest)
  // Its digest is public (inspection answers it); naming it must not hand B A's files.
  const response = await f.create({ sourceDigest: secret.digest })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({
    error: { details: { code: "workspace_source_not_held" } },
  })
  expect(rowsCreated(f.decisions)).toBe(1)
})

it("binds an upload to its uploader, so a policy can refuse another principal's upload", async () => {
  /** Uploads are stamped with the caller; a create must name a source its caller uploaded. */
  const sameUploader = {
    fallback: (req: {
      operation: string
      headers: Readonly<Record<string, string>>
      requestedWorkspace?: { uploadedBy?: readonly Record<string, unknown>[] }
    }) => {
      const user = req.headers["x-user-id"]
      if (!user) return { decision: "deny" as const, status: 403 as const }
      if (req.operation === "workspace.source.put")
        return { decision: "allow" as const, stamp: { ownerId: user } }
      const uploadedBy = req.requestedWorkspace?.uploadedBy
      if (uploadedBy && !uploadedBy.some((principal) => principal.ownerId === user))
        return { decision: "deny" as const, status: 403 as const }
      return { decision: "allow" as const }
    },
  }
  const f = await fixture({ policy: sameUploader })
  const bundle = source("u-1's files")
  const call = (user: string, method: string, path: string, body: unknown) =>
    f.raw(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "x-user-id": user },
        body: JSON.stringify(body),
      }),
    )
  expect((await call("u-1", "PUT", `/workspace/sources/${bundle.digest}`, bundle)).status).toBe(201)
  const stolen = await call("u-2", "POST", "/threads", {
    metadata: {},
    workspace: { sourceDigest: bundle.digest },
  })
  expect(stolen.status).toBe(403)
  const own = await call("u-1", "POST", "/threads", {
    metadata: {},
    workspace: { sourceDigest: bundle.digest },
  })
  expect(own.status).toBe(200)
  // Once u-2 uploads the same bytes itself, it may choose them too.
  expect((await call("u-2", "PUT", `/workspace/sources/${bundle.digest}`, bundle)).status).toBe(200)
  expect(
    (
      await call("u-2", "POST", "/threads", {
        metadata: {},
        workspace: { sourceDigest: bundle.digest },
      })
    ).status,
  ).toBe(200)
})

it("limits the creates naming a workspace that run at once", async () => {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let blocked = 0
  /** Allows everything, but holds each create's recheck until released. */
  const slow = {
    fallback: async (req: { action: string; operation: string }) => {
      if (req.action === "update" && req.operation === "thread.create") {
        blocked++
        await released
      }
      return { decision: "allow" as const }
    },
  }
  const f = await fixture({ policy: slow })
  const bundle = source("x")
  expect((await f.upload(bundle)).status).toBe(201)
  const creates = Array.from({ length: 5 }, () => f.create({ sourceDigest: bundle.digest }))
  // One of five is refused while four hold their slots; creates without a workspace are not limited.
  const first = await Promise.race(creates.map((p, i) => p.then((r) => ({ i, r }))))
  expect(first.r.status).toBe(429)
  expect(first.r.headers.get("retry-after")).toBe("1")
  expect(await first.r.json()).toMatchObject({
    error: { details: { code: "workspace_create_in_flight" } },
  })
  const plain = f.call("POST", "/threads", { metadata: {} })
  await expect.poll(() => blocked).toBe(5)
  release()
  expect((await plain).status).toBe(200)
  const rest = await Promise.all(creates)
  expect(rest.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 429])
  // The slots are free again.
  expect((await f.create({ sourceDigest: bundle.digest })).status).toBe(200)
})

it("answers an oversized create the gate's refusal first, so the option stays hidden", async () => {
  const f = await fixture()
  const big = {
    metadata: { pad: "x".repeat(1024 * 1024) },
    workspace: { sourceDigest: "a".repeat(64) },
  }
  expect((await f.call("POST", "/threads", big, null)).status).toBe(403)
  const off = await fixture({ stagedWorkspaces: false })
  expect((await off.call("POST", "/threads", big, null)).status).toBe(403)
  // Authorized: the limit answers, and the policy saw a plain create (nothing read yet).
  expect((await f.call("POST", "/threads", big)).status).toBe(413)
  expect(f.decisions.filter((d) => d.operation === "thread.create").at(-1)).toEqual({
    action: "create",
    operation: "thread.create",
    requestedWorkspace: undefined,
  })
  expect(rowsCreated(f.decisions)).toBe(0)
})

it("abandons an upload whose body stalls past the deadline, and frees the slot", async () => {
  const f = await fixture({ stagedWorkspaces: { uploadTimeoutMs: 1_000 } })
  const bundle = source("x")
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":1,'))
      // ...and never another byte.
    },
  })
  const started = Date.now()
  const response = await f.raw(
    new Request(`http://localhost/workspace/sources/${bundle.digest}`, {
      method: "PUT",
      headers: { authorization: TOKEN },
      body: stalled,
      duplex: "half",
    } as RequestInit),
  )
  expect(response.status).toBe(408)
  expect(await response.json()).toMatchObject({ error: { details: { code: "upload_timeout" } } })
  expect(Date.now() - started).toBeLessThan(10_000)
  expect((await f.upload(bundle)).status).toBe(201)
})
