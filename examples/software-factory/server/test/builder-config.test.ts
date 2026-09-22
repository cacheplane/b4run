import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BuilderManifest } from "../src/builder-manifest.ts"

/**
 * The builder's config is now a function of ONE input: the manifest the controller writes.
 * These tests build that input themselves rather than importing the controller's catalog —
 * the whole point of Task 3 is that this package can be understood, typechecked and tested
 * without the controller's source, and a test that imported it would hide a regression.
 */
const bundle = createSourceBundle([
  { path: "TASK.md", bytes: Buffer.from("# Repair the flag parser\n"), executable: false },
  { path: "src/cli.ts", bytes: Buffer.from("export const run = () => 0\n"), executable: false },
])

const manifest: BuilderManifest = {
  version: 1,
  taskId: "fixture-task",
  target: {
    id: "fixture-target",
    scope: "software-factory-builder",
    image: "b4-factory-fixture-target:deadbeefcafe-0123456789ab",
    policy: {
      network: { mode: "deny" },
      env: { npm_config_cache: "/tmp/npm-cache" },
      resources: { memoryMb: 2048, cpus: 2, timeoutMs: 120_000 },
    },
    permissions: { bash: ["npm test", "node ", "cat"], readFile: ["/deps"], listDir: ["/deps"] },
  },
  workspace: { version: 1, source: bundle, environmentLinks: [] },
  prompt:
    "Read TASK.md. Run the tests with `npm test`. Use readFile, listDir, writeFile and runBash.",
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "builder-manifest-fixture-"))
  const path = join(dir, "manifest.json")
  writeFileSync(path, JSON.stringify(manifest))
  process.env.FACTORY_BUILDER_MANIFEST = path
  vi.resetModules()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.FACTORY_BUILDER_MANIFEST
})

const loadConfig = async () => (await import("../b4.config.ts")).default
const thread = { threadId: "t", metadata: {}, signal: new AbortController().signal }

describe("builder configuration", () => {
  it("denies the network and pins the manifest's image", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
  })

  it("serves the captured workspace the controller handed it, unchanged", async () => {
    const config = await loadConfig()
    const workspace = config.sandbox?.workspace
    // A resolver, not a static definition: the bytes come from the manifest, and
    // sub-project 3 makes this a per-thread choice.
    if (typeof workspace !== "function")
      throw new Error("builder config must resolve its workspace from the manifest")
    const resolved = await workspace(thread)
    expect("source" in resolved && "digest" in resolved.source).toBe(true)
    expect((resolved as { source: { digest: string } }).source.digest).toBe(bundle.digest)
  })

  it("pre-approves exactly what the manifest allows, so an interrupt is a surprise", async () => {
    const config = await loadConfig()
    expect(config.permissions?.allow).toEqual(manifest.target.permissions)
    const bash = config.permissions?.allow?.bash ?? []
    expect(bash).toContain("npm test")
    // Prefix matching is why this has a trailing space.
    expect(bash).toContain("node ")
    expect(bash.some((pattern) => pattern.includes("rm"))).toBe(false)
  })

  it("keeps the builder's own review tools nonexistent", async () => {
    const config = await loadConfig()
    // Rung 1's whole point: the builder has no channel for a verdict.
    expect(config.permissions?.allow?.tool ?? []).toEqual([])
  })
})

describe("the builder route", () => {
  it("is a bounded agent with no approval gate and no custom tool", async () => {
    const builder = (await import("../src/app/build/index.ts")).default
    expect(builder.tools?.approve ?? []).toEqual([])
    expect(builder.recursionLimit).toBeGreaterThan(0)
    expect(builder.systemPrompt).toMatch(/readFile/)
    // It must not be told to verify or to export; those are the controller's.
    expect(builder.systemPrompt).not.toMatch(/prepareReview|exportForReview/)
  })

  it("takes the task's prompt from the manifest rather than deriving one", async () => {
    const builder = (await import("../src/app/build/index.ts")).default
    expect(builder.systemPrompt).toContain(manifest.prompt)
  })
})

describe("a drifted manifest", () => {
  it("refuses to boot rather than silently losing the network denial", async () => {
    const drifted = JSON.parse(JSON.stringify(manifest))
    drifted.target.policy.netwrok = drifted.target.policy.network
    delete drifted.target.policy.network
    writeFileSync(join(dir, "drifted.json"), JSON.stringify(drifted))
    process.env.FACTORY_BUILDER_MANIFEST = join(dir, "drifted.json")
    vi.resetModules()
    // The builder is the untrusted side: it would rather not start than start with a policy
    // it cannot account for.
    await expect(loadConfig()).rejects.toThrow()
  })
})

describe("the package boundary", () => {
  it("imports no controller source, anywhere", () => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const files = [join(root, "b4.config.ts")]
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name)
        if (entry.isDirectory()) walk(child)
        else if (entry.isFile() && child.endsWith(".ts")) files.push(child)
      }
    }
    walk(join(root, "src"))
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      // The builder is the untrusted side. It reads a manifest; it never reaches across
      // into the code that judges what it left behind.
      expect([file, readFileSync(file, "utf8").includes("../controller/")]).toEqual([file, false])
    }
  })
})
