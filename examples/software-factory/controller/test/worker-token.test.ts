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
  // Not yet on the type (PR 4 adds it as required); harmless before, needed after.
  requestedWorkspace: undefined,
  resuming: false,
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
