import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveSandboxManager } from "../src/lib/runtime/resolve-sandbox.js"

const fixtureUrl = new URL("./support/managed-provider.ts", import.meta.url).href

// excludeDirectories keeps the config loader's own ".b4" cache dir (created the
// moment b4.config.ts is loaded) out of the "." capture; without it the exact
// inventory check trips on files the resolver never claimed.
async function writeResolverApp(
  resolverBody = `async () => ({ source: { directory: ".", include: ["b4.config.ts"], excludeDirectories: [".b4"] } })`,
): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-cfg-"))
  await mkdir(join(appRoot, "workspace"), { recursive: true })
  await writeFile(
    join(appRoot, "b4.config.ts"),
    [
      `import { managedProviderFixture } from ${JSON.stringify(fixtureUrl)}`,
      `export default { sandbox: { provider: managedProviderFixture().provider, workspace: ${resolverBody} } }`,
    ].join("\n"),
    "utf8",
  )
  return appRoot
}

describe("resolveSandboxManager", () => {
  test("returns undefined when no b4.config.ts", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-cfg-"))
    expect(await resolveSandboxManager(appRoot)).toBeUndefined()
  })

  test("builds a manager from config.sandbox.provider", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-cfg-"))
    await writeFile(
      join(appRoot, "b4.config.ts"),
      [
        `import { fakeSandbox } from "@b4run/sandbox/testing"`,
        `export default { sandbox: { provider: fakeSandbox(), network: { mode: "deny" } } }`,
      ].join("\n"),
      "utf8",
    )
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr).toBeDefined()
  })

  test("builds a managed manager from a resolver in development mode", async () => {
    const appRoot = await writeResolverApp()
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr?.managed).toBe(true)
    await mgr?.releaseAll()
  })

  test("refuses a built static artifact under a resolver config", async () => {
    const appRoot = await writeResolverApp()
    await expect(
      resolveSandboxManager(appRoot, {
        built: true,
        artifact: { version: 1, descriptorDigest: "0".repeat(64), workspace: {} },
      }),
    ).rejects.toThrow(/rebuild/i)
  })

  // A resolver artifact under a resolver config must boot: the mismatch error would be unactionable.
  test("boots a resolver config from a resolver artifact in built mode", async () => {
    const appRoot = await writeResolverApp()
    const mgr = await resolveSandboxManager(appRoot, {
      built: true,
      artifact: JSON.parse(JSON.stringify({ version: 2, kind: "resolver" })),
    })
    expect(mgr?.managed).toBe(true)
    await mgr?.releaseAll()
  })

  test("admits a thread through the resolver, capturing the definition it returns", async () => {
    const appRoot = await writeResolverApp()
    const mgr = await resolveSandboxManager(appRoot)
    try {
      const signal = new AbortController().signal
      await mgr!.getForThread("t1", signal, { metadata: async () => ({}) })
      const admitted = mgr!.getWorkspace("t1")
      expect(admitted).toBeDefined()
      expect(new TextDecoder().decode(admitted!.readInitialFile("b4.config.ts"))).toContain(
        "managedProviderFixture",
      )
    } finally {
      await mgr?.releaseAll()
    }
  })

  test("attributes a throwing resolver's error to its thread", async () => {
    const appRoot = await writeResolverApp(
      `async ({ threadId }) => { throw new Error("no task for " + threadId) }`,
    )
    const mgr = await resolveSandboxManager(appRoot)
    try {
      const signal = new AbortController().signal
      await expect(mgr!.getForThread("t2", signal)).rejects.toThrow(
        /Workspace resolver for thread t2: no task for t2/,
      )
    } finally {
      await mgr?.releaseAll()
    }
  })

  test("a resolver returning nothing gets the friendly message, not a TypeError", async () => {
    const appRoot = await writeResolverApp(`async () => undefined`)
    const mgr = await resolveSandboxManager(appRoot)
    try {
      const signal = new AbortController().signal
      await expect(mgr!.getForThread("t3", signal)).rejects.toThrow(
        /Workspace resolver for thread t3: returned no workspace definition/,
      )
    } finally {
      await mgr?.releaseAll()
    }
  })
})
