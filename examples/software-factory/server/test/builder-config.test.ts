import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BuilderManifest } from "../src/builder-manifest.ts"

/**
 * The builder's config is a function of ONE input: the manifest directory the controller writes
 * one manifest per work order into (the workspace, image, policy and permissions of that work
 * order's thread); its thread resolver is a function of ONE thread fact,
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

const manifest = (
  workOrderId: string,
  text: string,
  targetId = "fixture-target",
  pin = "d".repeat(40),
): BuilderManifest => ({
  version: 2,
  workOrderId,
  taskId: "fixture-task",
  targetId,
  target: {
    // The factory's tag shape, naming this manifest's own target and pin.
    image: `b4-factory-${targetId}:${pin.slice(0, 12)}-0123456789ab`,
    pin,
    policy: {
      network: { mode: "deny" },
      env: { npm_config_cache: "/tmp/npm-cache" },
      resources: { memoryMb: 2048, cpus: 2, timeoutMs: 120_000 },
    },
    permissions: { bash: ["npm test", "node ", "cat"], readFile: ["/deps"], listDir: ["/deps"] },
  },
  workspace: { version: 1, source: bundle(text), environmentLinks: [] },
})

let dir: string
let manifestDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "builder-config-fixture-"))
  manifestDir = join(dir, "manifests")
  mkdirSync(manifestDir)
  process.env.FACTORY_BUILDER_MANIFEST_DIR = manifestDir
  vi.resetModules()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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
  const sandbox = (await loadConfig()).sandbox
  // A thread resolver, not a workspace resolver: the bytes, the image, the policy and the
  // permissions are all the work order's, per thread.
  if (typeof sandbox?.thread !== "function")
    throw new Error("builder config must resolve each thread's whole sandbox")
  expect(sandbox.workspace).toBeUndefined()
  return sandbox.thread
}
const digestOf = (resolved: unknown) =>
  (resolved as { workspace: { source: { digest: string } } }).workspace.source.digest

describe("builder configuration", () => {
  it("serves its threads' workspaces over its own port, behind src/thread-access.ts", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.workspaceRead).toBe("http")
    expect(existsSync(fileURLToPath(new URL("../src/thread-access.ts", import.meta.url)))).toBe(
      true,
    )
  })

  it("boots with no target file and denies the network to every thread", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
  })

  it("refuses an unlisted command as a tool error instead of parking it for nobody", async () => {
    // The first live run's builder parked on `sed -n` with no one to answer, and the
    // controller blocked its only attempt. The mode is the builder app's, never a manifest's.
    const config = await loadConfig()
    expect(config.permissions?.mode).toBe("non-interactive")
    // The allow-list is each thread's own, from its manifest; the app pre-approves nothing.
    expect(config.permissions?.allow).toBeUndefined()
  })

  it("addresses the controller's reader's storage: one scope, no default image", () => {
    const text = readFileSync(new URL("../b4.config.ts", import.meta.url), "utf8")
    // Scope and allowed images, and no default image: the controller's reader builds the same.
    expect(text).toContain(
      'dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage })',
    )
  })
})

describe("the builder's thread resolver", () => {
  it("serves each work order its own workspace, image, policy and permissions", async () => {
    const alpha = manifest("wo-alpha", "export const run = () => 0\n")
    const beta = manifest("wo-beta", "export const run = () => 1\n", "other-target", "e".repeat(40))
    beta.target = {
      ...beta.target,
      policy: {
        ...beta.target.policy,
        resources: { memoryMb: 8192, cpus: 4, timeoutMs: 600_000 },
      },
      permissions: { bash: ["make"] },
    }
    writeManifest(alpha, "wo-alpha")
    writeManifest(beta, "wo-beta")
    const resolve = await resolver()
    const first = await resolve(thread({ factoryWorkOrderId: "wo-alpha" }, "t-alpha"))
    const second = await resolve(thread({ factoryWorkOrderId: "wo-beta" }, "t-beta"))
    expect(digestOf(first)).toBe(digestOf({ workspace: alpha.workspace }))
    expect(digestOf(second)).toBe(digestOf({ workspace: beta.workspace }))
    expect(digestOf(first)).not.toBe(digestOf(second))
    // One builder, two targets: each thread runs its own manifest's image under its own
    // policy and allow-list, which the framework records at the thread's first admission.
    expect(first.environment).toEqual({ image: alpha.target.image })
    expect(second.environment).toEqual({
      image: `b4-factory-other-target:${"e".repeat(12)}-0123456789ab`,
    })
    expect(first.policy).toEqual(alpha.target.policy)
    expect(second.policy?.resources).toEqual({ memoryMb: 8192, cpus: 4, timeoutMs: 600_000 })
    expect(first.permissions).toEqual({ allow: alpha.target.permissions })
    expect(second.permissions).toEqual({ allow: { bash: ["make"] } })
  })

  it("refuses a manifest whose image names another target or another pin", async () => {
    const good = manifest("wo-alpha", "x\n")
    writeManifest(
      { ...good, target: { ...good.target, image: "b4-factory-devkit:dddddddddddd-0123456789ab" } },
      "wo-alpha",
    )
    writeManifest(
      {
        ...manifest("wo-beta", "x\n"),
        target: { ...good.target, image: "b4-factory-fixture-target:eeeeeeeeeeee-0123456789ab" },
      },
      "wo-beta",
    )
    const resolve = await resolver()
    // Both are factory-shaped tags the provider's `images` predicate would admit; only the
    // manifest's own target and pin make them wrong, and the thread is refused before any
    // image is resolved.
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow(
      /is not target fixture-target at pin d{40}/,
    )
    await expect(resolve(thread({ factoryWorkOrderId: "wo-beta" }))).rejects.toThrow(
      /is not target fixture-target at pin d{40}/,
    )
  })

  it("allows only the factory's own images", async () => {
    const { isFactoryImage } = await import("../src/builder-manifest.ts")
    expect(isFactoryImage("b4-factory-devkit:6a59e00aed46-0123456789ab")).toBe(true)
    expect(isFactoryImage("alpine:latest")).toBe(false)
    expect(isFactoryImage("b4-factory-devkit:latest")).toBe(false)
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
    writeManifest({ ...manifest("wo-beta", "x\n"), version: 1 }, "wo-beta")
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
    // Nothing of a work order's inputs reaches it: every target's work orders share it.
    expect(builder.systemPrompt).not.toContain("fixture-target")
    delete process.env.FACTORY_BUILDER_MANIFEST_DIR
    vi.resetModules()
    const again = (await import("../src/app/build/index.ts")).default
    expect(again.systemPrompt).toBe(builder.systemPrompt)
  })
})

describe("the retired target file", () => {
  it("is a boot error naming FACTORY_BUILDER_TARGET, not a variable silently ignored", async () => {
    process.env.FACTORY_BUILDER_TARGET = join(dir, "cli-flags.target.json")
    vi.resetModules()
    try {
      // An operator still pointing the builder at a target file would otherwise believe it
      // chooses the builder's image, policy and permissions; each work order's manifest does.
      await expect(loadConfig()).rejects.toThrow(
        /FACTORY_BUILDER_TARGET is retired: the builder boots with no target file/,
      )
    } finally {
      delete process.env.FACTORY_BUILDER_TARGET
    }
  })
})

describe("a missing manifest directory", () => {
  it("is a boot error, but an empty one is not", async () => {
    await expect(loadConfig()).resolves.toBeDefined()
    delete process.env.FACTORY_BUILDER_MANIFEST_DIR
    vi.resetModules()
    await expect(loadConfig()).rejects.toThrow(/FACTORY_BUILDER_MANIFEST_DIR/)
  })
})

describe("a drifted manifest", () => {
  it("refuses the thread rather than silently losing the network denial", async () => {
    const drifted = JSON.parse(JSON.stringify(manifest("wo-alpha", "x\n")))
    drifted.target.policy.netwrok = drifted.target.policy.network
    delete drifted.target.policy.network
    writeManifest(drifted, "wo-alpha")
    const resolve = await resolver()
    // Without strict parsing the thread would run under the app's network rather than the
    // one the controller wrote. The builder would rather refuse a thread than run it under a
    // policy it cannot account for.
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }))).rejects.toThrow(
      /builder manifest .* is invalid/,
    )
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
  // The repository's own `build` and `check` walk every workspace package with no Docker in
  // hand, and this builder's `check` runs the Docker provider's preflight. The guard is what
  // keeps that from reddening the whole graph — and it must not become a guard that swallows
  // failures in the lane, which is the case the Docker lane depends on.
  const script = fileURLToPath(new URL("../scripts/in-lane.mjs", import.meta.url))

  it("skips the command with a notice outside the lane", () => {
    const { FACTORY_BUILDER_LANE: _omitted, ...clean } = process.env
    for (const env of [clean, { ...clean, FACTORY_BUILDER_LANE: "true" }]) {
      const result = spawnSync(process.execPath, [script, "b4", "build"], {
        encoding: "utf8",
        env,
        timeout: 30_000,
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("builder: FACTORY_BUILDER_LANE is not 1; skipping b4 build")
    }
  })

  it("passes the command's exit code through in the lane", () => {
    // The guard decides only whether to run. A guard that exited 0 here would hide every
    // builder build.
    const result = spawnSync(
      process.execPath,
      [script, process.execPath, "-e", "process.exit(3)"],
      {
        encoding: "utf8",
        env: { ...process.env, FACTORY_BUILDER_LANE: "1" },
        timeout: 30_000,
      },
    )
    expect(result.status).toBe(3)
  })
})
