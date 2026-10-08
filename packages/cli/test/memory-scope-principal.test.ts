import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { MemoryRecord } from "@b4run/memory"
import { sqliteMemoryStore } from "@b4run/memory"
import { type AuthDefinition, defineAuth } from "@b4run/sdk"
import { afterEach, describe, expect, test } from "vitest"

import { callerOwnsNamespace } from "../src/lib/dev/memory-handler.js"
import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"
import { buildMemoryContext, UNSCOPED_NAMESPACE } from "../src/lib/runtime/memory-context.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const SHARED = "workspace=fixture|route=/noop"
const ALICE = `${SHARED}|user=alice`
const BOB = `${SHARED}|user=bob`

/** `src/auth.ts`: `{ id }` from `x-user`; `owner` may review every namespace. */
const auth = defineAuth({
  authenticate: ({ headers }) => (headers["x-user"] ? { id: headers["x-user"] } : undefined),
  canReviewMemory: (principal) => principal.id === "owner",
})

async function fixture(options: { readonly auth?: AuthDefinition } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-memory-scope-principal-"))
  tempDirs.push(appRoot)
  const files: Record<string, string> = {
    // The scope a request's memory lives in comes from its principal.
    "b4.config.ts":
      "export default { memory: { resolveScope: ({ principal }) => (principal ? { user: principal.id } : {}) } };\n",
    "package.json": '{"type":"module"}\n',
    "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const store = sqliteMemoryStore({ path: join(appRoot, ".b4", "memory.sqlite") })
  for (const [id, namespace] of [
    ["cand_alice", ALICE],
    ["cand_bob", BOB],
    ["cand_shared", SHARED],
  ] as const) {
    const record: MemoryRecord = {
      id,
      kind: "semantic",
      namespace,
      content: id,
      status: "candidate",
      data: {},
      source: { type: "eval", id: "seed" },
      confidence: 1,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await store.put(record)
  }
  const server = await startRuntimeServer({
    appRoot,
    ...(options.auth ? { auth: options.auth } : {}),
  })
  servers.push(server)
  return { server, store }
}

async function list(url: string, user?: string): Promise<string[]> {
  const response = await fetch(new URL("/memory/candidates", url), {
    headers: user ? { "x-user": user } : {},
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { candidates: MemoryRecord[] }
  return body.candidates.map((record) => record.id).sort()
}

function post(url: string, path: string, user?: string): Promise<Response> {
  return fetch(new URL(path, url), { headers: user ? { "x-user": user } : {}, method: "POST" })
}

describe("memory candidates with src/auth.ts", () => {
  test("a caller lists its own namespace and the shared one; an anonymous caller only the shared one", async () => {
    const { server } = await fixture({ auth })
    expect(await list(server.url, "alice")).toEqual(["cand_alice", "cand_shared"])
    expect(await list(server.url, "bob")).toEqual(["cand_bob", "cand_shared"])
    expect(await list(server.url)).toEqual(["cand_shared"])
  })

  test("canReviewMemory admits a reviewer to every namespace", async () => {
    const { server } = await fixture({ auth })
    expect(await list(server.url, "owner")).toEqual(["cand_alice", "cand_bob", "cand_shared"])
  })

  test("approve and reject outside the caller's namespaces answer 404, exactly like a missing record", async () => {
    const { server, store } = await fixture({ auth })
    const foreignApprove = await post(server.url, "/memory/candidates/cand_bob/approve", "alice")
    const missingApprove = await post(server.url, "/memory/candidates/no_such/approve", "alice")
    expect(foreignApprove.status).toBe(404)
    expect(missingApprove.status).toBe(404)
    // Same body shape and message pattern: the route is not an existence oracle.
    const shape = async (response: Response) =>
      Object.keys((await response.json()) as Record<string, unknown>)
    expect(await shape(foreignApprove)).toEqual(await shape(missingApprove))

    expect((await post(server.url, "/memory/candidates/cand_bob/reject", "alice")).status).toBe(404)
    expect((await post(server.url, "/memory/candidates/no_such/reject", "alice")).status).toBe(404)
    expect((await store.get("cand_bob"))?.status).toBe("candidate")

    expect((await post(server.url, "/memory/candidates/cand_alice/approve", "alice")).status).toBe(
      200,
    )
    expect((await store.get("cand_alice"))?.status).toBe("active")
    expect((await post(server.url, "/memory/candidates/cand_bob/reject", "owner")).status).toBe(200)
    expect(await store.get("cand_bob")).toBeNull()
  })

  test("with no src/auth.ts the routes review every namespace, as before", async () => {
    const { server } = await fixture()
    expect(await list(server.url, "alice")).toEqual(["cand_alice", "cand_bob", "cand_shared"])
  })
})

describe("callerOwnsNamespace", () => {
  const resolveScope = ({
    principal,
  }: {
    readonly principal: { readonly id: string } | undefined
  }) => (principal ? { user: principal.id } : {})

  test("owns a namespace whose owned dimensions match its resolved scope", () => {
    const context = { appRoot: "/app", principal: { id: "alice" }, resolveScope }
    expect(callerOwnsNamespace(ALICE, context)).toBe(true)
    expect(callerOwnsNamespace(BOB, context)).toBe(false)
    expect(callerOwnsNamespace(SHARED, context)).toBe(true)
  })

  test("owns no scoped namespace without resolveScope, or when it throws", () => {
    expect(
      callerOwnsNamespace(ALICE, {
        appRoot: "/app",
        principal: { id: "alice" },
        resolveScope: undefined,
      }),
    ).toBe(false)
    const throws = () => {
      throw new Error("boom")
    }
    expect(
      callerOwnsNamespace(ALICE, {
        appRoot: "/app",
        principal: { id: "alice" },
        resolveScope: throws,
      }),
    ).toBe(false)
  })
})

describe("buildMemoryContext", () => {
  const base = {
    store: {} as never,
    writes: "auto" as const,
    appRoot: "/apps/fixture",
    routePath: "/chat",
    now: () => "2026-01-01T00:00:00.000Z",
  }
  const defined = (scope: string[]) =>
    ({ kind: "semantic", scope, schema: { safeParse: () => ({ success: true }) } }) as never

  test("a declared dimension with a value scopes the namespace", () => {
    const context = buildMemoryContext({
      ...base,
      defined: defined(["workspace", "route", "user"]),
      extraScope: { user: "alice" },
    })
    expect(context.namespace).toBe("workspace=fixture|route=/chat|user=alice")
    expect(context.unavailable).toBeUndefined()
  })

  test("a declared dimension without one fails closed instead of falling back to the shared namespace", () => {
    const context = buildMemoryContext({
      ...base,
      defined: defined(["workspace", "route", "user"]),
    })
    expect(context.namespace).toBe(UNSCOPED_NAMESPACE)
    expect(context.unavailable).toMatch(/no user scope/)
  })

  test("a route that declares only the missing dimension does not throw", () => {
    const context = buildMemoryContext({ ...base, defined: defined(["user"]) })
    expect(context.unavailable).toMatch(/no user scope/)
  })
})
