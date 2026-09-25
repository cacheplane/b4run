import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BuilderHandoff } from "../src/builder-handoff.ts"

/**
 * The builder's config reads nothing per work order from disk: its thread resolver is a
 * function of the thread's metadata (`factoryWorkOrderId`, and the work order's target in
 * `factoryBuilder`) and of the workspace the thread was created with (`thread.staged`), which
 * must be the one the handoff names. These tests build both inputs themselves rather than
 * importing the controller's catalog: this package must be understood, typechecked and
 * tested without the controller's source, and a test that imported it would hide a
 * regression.
 */
const bundle = (text: string) =>
  createSourceBundle([
    { path: "TASK.md", bytes: Buffer.from("# Repair the flag parser\n"), executable: false },
    { path: "src/cli.ts", bytes: Buffer.from(text), executable: false },
  ])

/** A stand-in image id, distinct per target and pin. */
const imageIdOf = (targetId: string, pin: string) =>
  `sha256:${createHash("sha256").update(`${targetId}@${pin}`).digest("hex")}`

interface WorkOrder {
  readonly handoff: BuilderHandoff
  readonly staged: CapturedWorkspaceDefinition
}

const workOrder = (
  workOrderId: string,
  text: string,
  targetId = "fixture-target",
  pin = "d".repeat(40),
): WorkOrder => {
  const staged: CapturedWorkspaceDefinition = {
    version: 1,
    source: bundle(text),
    environmentLinks: [{ path: "node_modules", target: "/deps/node_modules" }],
    baseline: "git",
  }
  return {
    staged,
    handoff: {
      version: 4,
      workOrderId,
      taskId: "fixture-task",
      targetId,
      workspace: {
        sourceDigest: staged.source.digest,
        environmentLinks: [{ path: "node_modules", target: "/deps/node_modules" }],
        baseline: "git",
      },
      target: {
        // An image id, one per target and pin, and the factory's tag shape naming this
        // handoff's own target and pin beside it.
        image: imageIdOf(targetId, pin),
        tag: `b4-factory-${targetId}:${pin.slice(0, 12)}-0123456789ab`,
        pin,
        policy: {
          network: { mode: "deny" },
          env: { npm_config_cache: "/tmp/npm-cache" },
          resources: { memoryMb: 2048, cpus: 2, timeoutMs: 120_000 },
        },
        permissions: {
          bash: ["npm test", "node ", "cat"],
          readFile: ["/deps"],
          listDir: ["/deps"],
        },
      },
    },
  }
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  delete process.env.FACTORY_BUILDER_MANIFEST_DIR
  delete process.env.FACTORY_BUILDER_TARGET
})

const loadConfig = async () => (await import("../b4.config.ts")).default
/** A thread as the framework hands it to the resolver at first admission. */
const thread = (
  metadata: Readonly<Record<string, unknown>>,
  staged?: CapturedWorkspaceDefinition,
  threadId = "t",
) => ({
  threadId,
  metadata,
  signal: new AbortController().signal,
  ...(staged !== undefined ? { staged } : {}),
})
/** The metadata `dispatch` creates a builder thread with. */
const metadataOf = (order: WorkOrder, handoff: unknown = order.handoff) => ({
  factoryWorkOrderId: order.handoff.workOrderId,
  factoryBuilder: handoff,
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
    // And takes each thread's workspace at creation, over the same port, behind the same policy.
    expect(config.sandbox?.stagedWorkspaces).toBe(true)
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
    // controller blocked its only attempt. The mode is the builder app's, never a handoff's.
    const config = await loadConfig()
    expect(config.permissions?.mode).toBe("non-interactive")
    // The allow-list is each thread's own, from its handoff; the app pre-approves nothing.
    expect(config.permissions?.allow).toBeUndefined()
  })

  it("has one scope and no default image: every thread runs the image its handoff names", () => {
    const text = readFileSync(new URL("../b4.config.ts", import.meta.url), "utf8")
    // Scope and allowed images, and no default image.
    expect(text).toContain(
      'dockerSandbox({ scope: "software-factory-builder", images: isFactoryImageId })',
    )
  })
})

describe("the builder's thread resolver", () => {
  it("serves each work order its own staged workspace, image, policy and permissions", async () => {
    const alpha = workOrder("wo-alpha", "export const run = () => 0\n")
    const beta = workOrder(
      "wo-beta",
      "export const run = () => 1\n",
      "other-target",
      "e".repeat(40),
    )
    const betaHandoff: BuilderHandoff = {
      ...beta.handoff,
      target: {
        ...beta.handoff.target,
        policy: {
          ...beta.handoff.target.policy,
          resources: { memoryMb: 8192, cpus: 4, timeoutMs: 600_000 },
        },
        permissions: { bash: ["make"] },
      },
    }
    const resolve = await resolver()
    const first = await resolve(thread(metadataOf(alpha), alpha.staged, "t-alpha"))
    const second = await resolve(thread(metadataOf(beta, betaHandoff), beta.staged, "t-beta"))
    expect(digestOf(first)).toBe(alpha.staged.source.digest)
    expect(digestOf(second)).toBe(beta.staged.source.digest)
    expect(digestOf(first)).not.toBe(digestOf(second))
    // The staged workspace whole: its links and baseline, not only its files.
    expect((first.workspace as CapturedWorkspaceDefinition).environmentLinks).toEqual(
      alpha.staged.environmentLinks,
    )
    expect((first.workspace as CapturedWorkspaceDefinition).baseline).toBe("git")
    // One builder, two targets: each thread runs its own handoff's image under its own
    // policy and allow-list, which the framework records at the thread's first admission.
    // By id: never a tag, which could have moved since the controller bound the image.
    expect(first.environment).toEqual({ image: alpha.handoff.target.image })
    expect(first.environment?.image).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(second.environment).toEqual({ image: imageIdOf("other-target", "e".repeat(40)) })
    expect(first.policy).toEqual(alpha.handoff.target.policy)
    expect(second.policy?.resources).toEqual({ memoryMb: 8192, cpus: 4, timeoutMs: 600_000 })
    expect(first.permissions).toEqual({ allow: alpha.handoff.target.permissions })
    expect(second.permissions).toEqual({ allow: { bash: ["make"] } })
  })

  it("refuses a handoff whose tag names another target or another pin", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const resolve = await resolver()
    // Both are factory-shaped tags naming a real target and pin; only the
    // handoff's own target and pin make them wrong, and the thread is refused before any
    // image is resolved.
    for (const tag of [
      "b4-factory-devkit:dddddddddddd-0123456789ab",
      "b4-factory-fixture-target:eeeeeeeeeeee-0123456789ab",
    ])
      await expect(
        resolve(
          thread(
            metadataOf(order, { ...order.handoff, target: { ...order.handoff.target, tag } }),
            order.staged,
          ),
        ),
      ).rejects.toThrow(/is not target fixture-target at pin d{40}/)
  })

  it("allows an image only by id, never by a tag, the factory's included", async () => {
    const { isFactoryImageId } = await import("../src/builder-handoff.ts")
    expect(isFactoryImageId(`sha256:${"0".repeat(64)}`)).toBe(true)
    expect(isFactoryImageId("b4-factory-devkit:6a59e00aed46-0123456789ab")).toBe(false)
    expect(isFactoryImageId("alpine:latest")).toBe(false)
    expect(isFactoryImageId(`sha256:${"0".repeat(63)}`)).toBe(false)
  })

  it("refuses, by name, a thread created with no handoff or with no staged workspace", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const resolve = await resolver()
    // A thread dispatched by an older controller (a manifest on disk, no handoff) is refused
    // at admission: drain in-flight work orders before upgrading.
    await expect(resolve(thread({ factoryWorkOrderId: "wo-alpha" }, order.staged))).rejects.toThrow(
      /factoryBuilder is required/,
    )
    await expect(resolve(thread(metadataOf(order)))).rejects.toThrow(
      "work order wo-alpha's thread was created without a staged workspace",
    )
  })

  it("refuses a staged workspace that is not the one the handoff names", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const other = workOrder("wo-alpha", "y\n")
    const resolve = await resolver()
    for (const staged of [
      // Other files.
      other.staged,
      // The same files, other links: they change what the thread runs.
      { ...order.staged, environmentLinks: [] },
      // The same files and links, no baseline.
      {
        version: 1 as const,
        source: order.staged.source,
        environmentLinks: order.staged.environmentLinks,
      },
    ])
      await expect(resolve(thread(metadataOf(order), staged))).rejects.toThrow(
        /is not the one work order wo-alpha names/,
      )
  })

  it("trusts nothing in the metadata beyond a catalog-id string and a strictly parsed handoff", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const resolve = await resolver()
    // Missing, path-like, and a non-string: each is refused, and the refusal names the key.
    for (const metadata of [
      { factoryBuilder: order.handoff },
      { factoryWorkOrderId: "../wo-alpha", factoryBuilder: order.handoff },
      { factoryWorkOrderId: ".hidden", factoryBuilder: order.handoff },
      { factoryWorkOrderId: 7, factoryBuilder: order.handoff },
    ]) {
      await expect(resolve(thread(metadata, order.staged))).rejects.toThrow(/factoryWorkOrderId/)
    }
  })

  it("refuses a handoff written for a different work order", async () => {
    const order = workOrder("wo-other", "x\n")
    const resolve = await resolver()
    await expect(
      resolve(
        thread({ factoryWorkOrderId: "wo-alpha", factoryBuilder: order.handoff }, order.staged),
      ),
    ).rejects.toThrow(/names work order wo-other, not wo-alpha/)
  })

  it("refuses a handoff that carries a prompt, the workspace's files, or is of another version", async () => {
    // The prompt is the run's user message, and the files travel as the upload: a handoff
    // carrying either is from something else and is refused rather than half-honoured.
    const order = workOrder("wo-alpha", "x\n")
    const resolve = await resolver()
    for (const handoff of [
      { ...order.handoff, prompt: "Read TASK.md." },
      { ...order.handoff, workspace: { ...order.handoff.workspace, source: order.staged.source } },
      { ...order.handoff, version: 2 },
    ])
      await expect(resolve(thread(metadataOf(order, handoff), order.staged))).rejects.toThrow(
        /factoryBuilder is invalid/,
      )
  })

  it("refuses a staged workspace whose bytes do not match its digest", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const tampered = JSON.parse(JSON.stringify(order.staged))
    tampered.source.files[0].base64 = Buffer.from("tampered").toString("base64")
    const resolve = await resolver()
    await expect(resolve(thread(metadataOf(order), tampered))).rejects.toThrow()
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
    vi.resetModules()
    const again = (await import("../src/app/build/index.ts")).default
    expect(again.systemPrompt).toBe(builder.systemPrompt)
  })
})

describe("the retired target file", () => {
  it("is a boot error naming FACTORY_BUILDER_TARGET, not a variable silently ignored", async () => {
    process.env.FACTORY_BUILDER_TARGET = "/tmp/cli-flags.target.json"
    vi.resetModules()
    try {
      // An operator still pointing the builder at a target file would otherwise believe it
      // chooses the builder's image, policy and permissions; each work order's handoff does.
      await expect(loadConfig()).rejects.toThrow(
        /FACTORY_BUILDER_TARGET is retired: the builder boots with no target file/,
      )
    } finally {
      delete process.env.FACTORY_BUILDER_TARGET
    }
  })
})

describe("the retired manifest directory", () => {
  it("is a boot error naming FACTORY_BUILDER_MANIFEST_DIR, and the builder boots without it", async () => {
    await expect(loadConfig()).resolves.toBeDefined()
    process.env.FACTORY_BUILDER_MANIFEST_DIR = "/tmp/builder-manifests"
    vi.resetModules()
    // An operator still pointing the builder at a manifest directory would otherwise believe
    // the controller shares one; nothing is read from it.
    await expect(loadConfig()).rejects.toThrow(/FACTORY_BUILDER_MANIFEST_DIR is retired/)
  })
})

describe("a drifted handoff", () => {
  it("refuses the thread rather than silently losing the network denial", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const drifted = JSON.parse(JSON.stringify(order.handoff))
    drifted.target.policy.netwrok = drifted.target.policy.network
    delete drifted.target.policy.network
    const resolve = await resolver()
    // Without strict parsing the thread would run under the app's network rather than the
    // one the controller sent. The builder would rather refuse a thread than run it under a
    // policy it cannot account for.
    await expect(resolve(thread(metadataOf(order, drifted), order.staged))).rejects.toThrow(
      /factoryBuilder is invalid/,
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
      // The builder is the untrusted side. It reads a handoff; it never reaches across
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
