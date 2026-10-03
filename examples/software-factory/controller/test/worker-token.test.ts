import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const builderPolicy = fileURLToPath(new URL("../../server/src/thread-access.ts", import.meta.url))
const drafterPolicy = fileURLToPath(new URL("../../drafter/src/thread-access.ts", import.meta.url))
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
  return import("../../server/src/thread-access.ts")
}

const request = (authorization?: string) => ({
  action: "read" as const,
  operation: "thread.get" as const,
  threadId: "t-1",
  thread: undefined,
  headers: authorization === undefined ? {} : { authorization },
  method: "GET",
  url: "/threads/t-1",
  requestedMetadata: undefined,
  requestedWorkspace: undefined,
  resuming: false,
})

const DIGEST = "d".repeat(64)
/** `PUT /workspace/sources/:digest`: a create with no thread, naming the upload's digest. */
const upload = (authorization?: string) => ({
  ...request(authorization),
  action: "create" as const,
  operation: "workspace.source.put" as const,
  threadId: undefined,
  method: "PUT",
  url: `/workspace/sources/${DIGEST}`,
  requestedWorkspace: { sourceDigest: DIGEST },
})
/** `POST /threads` naming a staged workspace, uploaded by `uploadedBy`. */
const create = (uploadedBy: readonly Record<string, unknown>[] | undefined) => ({
  ...request(`Bearer ${TOKEN}`),
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

describe("the workers' thread-access policy", () => {
  it("is the same file in the builder and the drafter", () => {
    expect(readFileSync(drafterPolicy, "utf8")).toBe(readFileSync(builderPolicy, "utf8"))
  })

  it("admits exactly `Bearer <FACTORY_WORKER_TOKEN>` and denies everything else with 403", async () => {
    const policy = (await load(TOKEN)).default
    expect(await policy.fallback(request(`Bearer ${TOKEN}`))).toEqual({ decision: "allow" })
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
      expect(await policy.fallback(request(wrong))).toEqual({ decision: "deny", status: 403 })
  })

  it("stamps the controller's uploads as the controller's, and denies anyone else's", async () => {
    const policy = (await load(TOKEN)).default
    expect(await policy.fallback(upload(`Bearer ${TOKEN}`))).toEqual({
      decision: "allow",
      stamp: { principal: "controller" },
    })
    for (const wrong of [undefined, `Bearer ${"u".repeat(40)}`])
      expect(await policy.fallback(upload(wrong))).toEqual({ decision: "deny", status: 403 })
  })

  it("admits a create naming a workspace only when the controller uploaded that source", async () => {
    const policy = (await load(TOKEN)).default
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
    const policy = (await load(TOKEN)).default
    expect(Object.keys(policy)).toEqual(["fallback"])
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
