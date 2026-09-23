import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BuilderManifest, BuilderTarget } from "../src/builder-manifest.ts"

/**
 * The builder's config is a function of TWO inputs: the target file (one per process: its
 * provider, policy and permissions) and the manifest directory the controller writes one
 * manifest per work order into; its resolver is a function of ONE thread fact,
 * `metadata.factoryWorkOrderId`. These tests build both inputs themselves rather than
 * importing the controller's catalog: this package must be understood, typechecked and
 * tested without the controller's source, and a test that imported it would hide a
 * regression.
 */
const bundle = (text: string) =>
  createSourceBundle([
    { path: "TASK.md", bytes: Buffer.from("# Repair the flag parser\n"), executable: false },
    { path: "src/cli.ts", bytes: Buffer.from(text), executable: false },
  ])

const target: BuilderTarget = {
  version: 1,
  target: {
    id: "fixture-target",
    scope: "software-factory-builder",
    image: "b4-factory-fixture-target:deadbeefcafe-0123456789ab",
    pin: "d".repeat(40),
    policy: {
      network: { mode: "deny" },
      env: { npm_config_cache: "/tmp/npm-cache" },
      resources: { memoryMb: 2048, cpus: 2, timeoutMs: 120_000 },
    },
    permissions: { bash: ["npm test", "node ", "cat"], readFile: ["/deps"], listDir: ["/deps"] },
  },
}

const manifest = (workOrderId: string, text: string): BuilderManifest => ({
  version: 1,
  workOrderId,
  taskId: "fixture-task",
  targetId: "fixture-target",
  workspace: { version: 1, source: bundle(text), environmentLinks: [] },
})

let dir: string
let manifestDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "builder-config-fixture-"))
  manifestDir = join(dir, "manifests")
  mkdirSync(manifestDir)
  const path = join(dir, "fixture-target.target.json")
  writeFileSync(path, JSON.stringify(target))
  process.env.FACTORY_BUILDER_TARGET = path
  process.env.FACTORY_BUILDER_MANIFEST_DIR = manifestDir
  vi.resetModules()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.FACTORY_BUILDER_TARGET
  delete process.env.FACTORY_BUILDER_MANIFEST_DIR
})

const writeManifest = (value: unknown, workOrderId: string) =>
  writeFileSync(join(manifestDir, `${workOrderId}.json`), JSON.stringify(value))
const loadConfig = async () => (await import("../b4.config.ts")).default
const thread = (metadata: Readonly<Record<string, unknown>>, threadId = "t") => ({
  threadId,
  metadata,
  signal: new AbortController().signal,
})
const resolver = async () => {
  const workspace = (await loadConfig()).sandbox?.workspace
  // A resolver, not a static definition: the bytes are the work order's, per thread.
  if (typeof workspace !== "function")
    throw new Error("builder config must resolve its workspace per thread")
  return workspace
}
const digestOf = (resolved: unknown) => (resolved as { source: { digest: string } }).source.digest

describe("builder configuration", () => {
  it("denies the network and pins the target's image", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
  })

  it("pre-approves exactly what the target allows, so an interrupt is a surprise", async () => {
    const config = await loadConfig()
    expect(config.permissions?.allow).toEqual(target.target.permissions)
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

describe("the builder's workspace resolver", () => {
  it("serves each work order its own captured workspace, unchanged", async () => {
    const alpha = manifest("wo-alpha", "export const run = () => 0\n")
    const beta = manifest("wo-beta", "export const run = () => 1\n")
    writeManifest(alpha, "wo-alpha")
    writeManifest(beta, "wo-beta")
    const resolve = await resolver()
    const first = await resolve(thread({ factoryWorkOrderId: "wo-alpha" }, "t-alpha"))
    const second = await resolve(thread({ factoryWorkOrderId: "wo-beta" }, "t-beta"))
    expect(digestOf(first)).toBe(digestOf(alpha.workspace))
    expect(digestOf(second)).toBe(digestOf(beta.workspace))
    expect(digestOf(first)).not.toBe(digestOf(second))
  })

  it("refuses a work order with no manifest, naming it and the directory", async () => {
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: "wo-none" }))).rejects.toThrow(
      "no builder manifest for wo-none",
    )
    await expect(resolve(thread({ factoryWorkOrderId: "wo-none" }))).rejects.toThrow(manifestDir)
  })

  it("trusts nothing in the metadata beyond a catalog-id string", async () => {
    writeManifest(manifest("wo-alpha", "x\n"), "wo-alpha")
    const resolve = await resolver()
    // Missing, a path that would escape the directory, and a non-string: each is refused
    // before any file is read, and the refusal names the key the client got wrong.
    for (const metadata of [
      {},
      { factoryWorkOrderId: "../wo-alpha" },
      { factoryWorkOrderId: ".hidden" },
      { factoryWorkOrderId: 7 },
    ]) {
      await expect(resolve(thread(metadata))).rejects.toThrow(/factoryWorkOrderId/)
    }
  })

  it("refuses a work order routed to the wrong builder", async () => {
    // The manifest is well formed and names its own work order, but it was captured for a
    // target this process does not serve: its image, policy and permissions are another's.
    writeManifest({ ...manifest("wo-alpha", "x\n"), targetId: "other-target" }, "wo-alpha")
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow(
      /is for target other-target, but this builder serves fixture-target/,
    )
  })

  it("refuses a manifest written for a different work order", async () => {
    writeManifest(manifest("wo-other", "x\n"), "wo-alpha")
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow(
      /names workOrderId wo-other/,
    )
  })

  it("refuses a manifest that still carries a prompt, or is of another version", async () => {
    // The prompt is the run's user message now; a manifest carrying one is from an older
    // controller and is refused rather than half-honoured.
    writeManifest({ ...manifest("wo-alpha", "x\n"), prompt: "Read TASK.md." }, "wo-alpha")
    writeManifest({ ...manifest("wo-beta", "x\n"), version: 2 }, "wo-beta")
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow(/prompt/)
    await expect(resolve(thread({ factoryWorkOrderId: "wo-beta" }))).rejects.toThrow(/version/)
  })

  it("refuses a workspace whose bytes do not match its digest", async () => {
    const tampered = JSON.parse(JSON.stringify(manifest("wo-alpha", "x\n")))
    tampered.workspace.source.digest = "0".repeat(64)
    writeManifest(tampered, "wo-alpha")
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow()
  })
})

describe("the builder route", () => {
  it("is a bounded agent with no approval gate and no custom tool", async () => {
    const builder = (await import("../src/app/build/index.ts")).default
    expect(builder.tools?.approve ?? []).toEqual([])
    expect(builder.recursionLimit).toBeGreaterThan(0)
    // It must not be told to verify or to export; those are the controller's.
    expect(builder.systemPrompt).not.toMatch(/prepareReview|exportForReview/)
  })

  it("has a fixed system prompt: the task's instructions are the run's user message", async () => {
    const builder = (await import("../src/app/build/index.ts")).default
    expect(builder.systemPrompt).toMatch(/TASK\.md/)
    expect(builder.systemPrompt).toMatch(/user's message/)
    // Nothing of the process's inputs reaches it: two work orders of one target share it.
    expect(builder.systemPrompt).not.toContain(target.target.id)
    delete process.env.FACTORY_BUILDER_TARGET
    delete process.env.FACTORY_BUILDER_MANIFEST_DIR
    vi.resetModules()
    const again = (await import("../src/app/build/index.ts")).default
    expect(again.systemPrompt).toBe(builder.systemPrompt)
  })
})

describe("a missing target", () => {
  it("is a boot error naming the variable and the command that writes it", async () => {
    delete process.env.FACTORY_BUILDER_TARGET
    vi.resetModules()
    // The builder cannot invent its own configuration, and the operator reading this error
    // needs to know both what is missing and what produces it.
    await expect(loadConfig()).rejects.toThrow(/FACTORY_BUILDER_TARGET/)
    await expect(loadConfig()).rejects.toThrow(/factory builder-target/)
  })

  it("is a boot error without the manifest directory too, but not with an empty one", async () => {
    await expect(loadConfig()).resolves.toBeDefined()
    delete process.env.FACTORY_BUILDER_MANIFEST_DIR
    vi.resetModules()
    await expect(loadConfig()).rejects.toThrow(/FACTORY_BUILDER_MANIFEST_DIR/)
  })
})

describe("a drifted target", () => {
  it("refuses to boot rather than silently losing the network denial", async () => {
    const drifted = JSON.parse(JSON.stringify(target))
    drifted.target.policy.netwrok = drifted.target.policy.network
    delete drifted.target.policy.network
    writeFileSync(join(dir, "drifted.json"), JSON.stringify(drifted))
    process.env.FACTORY_BUILDER_TARGET = join(dir, "drifted.json")
    vi.resetModules()
    // The builder is the untrusted side: it would rather not start than start with a policy
    // it cannot account for.
    await expect(loadConfig()).rejects.toThrow(/builder target .* is invalid/)
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

describe("the unfiltered turbo graph", () => {
  // The repository's own `build` and `check` walk every workspace package with no target in
  // hand, and this config refuses to load without one. The guard is what keeps that from
  // reddening the whole graph — and it must not become a guard that swallows failures when a
  // target IS present, which is the case the Docker lane depends on.
  const script = fileURLToPath(new URL("../scripts/with-target.mjs", import.meta.url))

  it("skips the command with a notice when no target is set", () => {
    const { FACTORY_BUILDER_TARGET: _omitted, ...clean } = process.env
    const result = spawnSync(process.execPath, [script, "b4", "build"], {
      encoding: "utf8",
      env: clean,
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("builder: FACTORY_BUILDER_TARGET is not set; skipping b4 build")
  })

  it("passes the command's exit code through when a target is set", () => {
    // The target's CONTENTS are the command's business, not the guard's: it decides only
    // whether to run, so a path that does not exist still runs the command and still
    // surfaces its failure. A guard that exited 0 here would hide every builder build.
    const result = spawnSync(
      process.execPath,
      [script, process.execPath, "-e", "process.exit(3)"],
      {
        encoding: "utf8",
        env: { ...process.env, FACTORY_BUILDER_TARGET: join(dir, "absent.json") },
        timeout: 30_000,
      },
    )
    expect(result.status).toBe(3)
  })
})
