import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const workerFile = (worker: "server" | "drafter", file: string) =>
  fileURLToPath(new URL(`../../${worker}/src/${file}`, import.meta.url))
const TOKEN = "t".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(token: string | undefined) {
  vi.resetModules()
  if (token === undefined) vi.stubEnv("FACTORY_WORKER_TOKEN", undefined as unknown as string)
  else vi.stubEnv("FACTORY_WORKER_TOKEN", token)
  // `resetModules` above makes this a fresh evaluation, so the module reads the stubbed token.
  return import("../../server/src/auth.ts")
}

/** Who `src/auth.ts` says presented `authorization`, with the worker token set to TOKEN. */
async function principalFor(authorization?: string) {
  const auth = (await load(TOKEN)).default
  return await auth.authenticate({
    headers: authorization === undefined ? {} : { authorization },
    method: "GET",
    url: "/threads/t-1",
  })
}

async function policy() {
  return (await import("../../server/src/thread-access.ts")).default
}

const CONTROLLER = { id: "controller" }

const request = (principal?: { readonly id: string }) => ({
  action: "read" as const,
  operation: "thread.get" as const,
  threadId: "t-1",
  thread: undefined,
  principal,
  method: "GET",
  url: "/threads/t-1",
  requestedMetadata: undefined,
  requestedWorkspace: undefined,
  resuming: false,
})

const DIGEST = "d".repeat(64)
/** `PUT /workspace/sources/:digest`: a create with no thread, naming the upload's digest. */
const upload = (principal?: { readonly id: string }) => ({
  ...request(principal),
  action: "create" as const,
  operation: "workspace.source.put" as const,
  threadId: undefined,
  method: "PUT",
  url: `/workspace/sources/${DIGEST}`,
  requestedWorkspace: { sourceDigest: DIGEST },
})
/** `POST /threads` naming a staged workspace, uploaded by `uploadedBy`. */
const create = (uploadedBy: readonly Record<string, unknown>[] | undefined) => ({
  ...request(CONTROLLER),
  action: "create" as const,
  operation: "thread.create" as const,
  threadId: undefined,
  method: "POST",
  url: "/threads",
  requestedMetadata: { factoryWorkOrderId: "wo-1" },
  requestedWorkspace:
    uploadedBy === undefined
      ? undefined
      : { sourceDigest: DIGEST, environmentLinks: [], uploadedBy },
})

describe("the workers' auth and thread-access policy", () => {
  it.each(["auth.ts", "thread-access.ts"])(
    "%s is the same file in the builder and the drafter",
    (file) => {
      expect(readFileSync(workerFile("drafter", file), "utf8")).toBe(
        readFileSync(workerFile("server", file), "utf8"),
      )
    },
  )

  it("resolves the controller from exactly `Bearer <FACTORY_WORKER_TOKEN>`, and nobody else", async () => {
    expect(await principalFor(`Bearer ${TOKEN}`)).toEqual(CONTROLLER)
    for (const wrong of [
      undefined,
      TOKEN,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      `bearer ${TOKEN}`,
      `Bearer ${TOKEN}, Bearer ${TOKEN}`,
      `Bearer ${"u".repeat(40)}`,
      "",
    ])
      expect(await principalFor(wrong)).toBeUndefined()
  })

  it("admits the controller to every thread endpoint and denies anyone else with 403", async () => {
    const { fallback } = await policy()
    expect(await fallback(request(CONTROLLER))).toEqual({ decision: "allow" })
    for (const wrong of [undefined, { id: "someone" }])
      expect(await fallback(request(wrong))).toEqual({ decision: "deny", status: 403 })
  })

  it("stamps the controller's uploads as the controller's, and denies anyone else's", async () => {
    const { fallback } = await policy()
    expect(await fallback(upload(CONTROLLER))).toEqual({
      decision: "allow",
      stamp: { principal: "controller" },
    })
    for (const wrong of [undefined, { id: "someone" }])
      expect(await fallback(upload(wrong))).toEqual({ decision: "deny", status: 403 })
  })

  it("admits a create naming a workspace only when the controller uploaded that source", async () => {
    const policy = await import("../../server/src/thread-access.ts").then((mod) => mod.default)
    // No workspace named: the ordinary create.
    expect(await policy.fallback(create(undefined))).toEqual({ decision: "allow" })
    expect(await policy.fallback(create([{ principal: "controller" }]))).toEqual({
      decision: "allow",
    })
    expect(
      await policy.fallback(create([{ principal: "someone" }, { principal: "controller" }])),
    ).toEqual({ decision: "allow" })
    // Never uploaded (or no longer held), or uploaded only under another stamp: refused, with a
    // body the controller's client reads as a code, never as a thread with no workspace.
    for (const uploadedBy of [
      [],
      [{ principal: "someone" }],
      [{ principal: "controller", extra: 1 }],
      [{ principal: ["controller"] }],
    ]) {
      const denied = await policy.fallback(create(uploadedBy))
      expect(denied).toMatchObject({
        decision: "deny",
        status: 403,
        body: { error: { details: { code: "workspace_not_uploaded_by_controller" } } },
      })
      expect(JSON.stringify(denied)).not.toContain(TOKEN)
    }
  })

  it("has no per-action handler: every operation goes through the one check", async () => {
    expect(Object.keys(await policy())).toEqual(["fallback"])
  })

  it("refuses to load without a token of at least 32 characters and no whitespace", async () => {
    await expect(load(undefined)).rejects.toThrow(/FACTORY_WORKER_TOKEN is required/)
    await expect(load("")).rejects.toThrow(/FACTORY_WORKER_TOKEN is required/)
    await expect(load("short")).rejects.toThrow(/at least 32/)
    await expect(load(`${"a".repeat(20)} ${"b".repeat(20)}`)).rejects.toThrow(/no whitespace/)
  })

  it("never echoes the token in a refusal", async () => {
    const secret = `${"s".repeat(20)} ${"e".repeat(20)}`
    const error = await load(secret).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(String(error)).toMatch(/no whitespace/)
    expect(String(error)).not.toContain("sssss")
  })
})
