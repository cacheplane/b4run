import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dockerSandbox } from "@b4run/sandbox"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The drafter's config reads nothing per work order from disk: its resolver is a function of
 * the thread's metadata (`factoryWorkOrderId`, and the handoff in `factoryDrafter`) and of the
 * workspace the thread was created with (`thread.staged`), which must be the one the handoff
 * names. These tests capture the workspace themselves with the framework's own capture
 * rather than importing the controller: the drafter package must be understood, typechecked
 * and tested without the controller's source.
 */
vi.mock("@b4run/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/sandbox")>()
  return { ...actual, dockerSandbox: vi.fn(actual.dockerSandbox) }
})

const WORK_ORDER = "wo-0123456789abcdef"
const thread = (
  metadata: Readonly<Record<string, unknown>>,
  staged?: CapturedWorkspaceDefinition,
) => ({
  threadId: "t-1",
  metadata,
  signal: new AbortController().signal,
  ...(staged !== undefined ? { staged } : {}),
})

let root: string

/** A capture in the shape the controller stages, and the handoff naming it. */
async function captured(text = "# fixture\n") {
  // A tiny tree: the repository under `repo/`, nothing else, and no baseline. The capture is
  // the framework's, so what the drafter checks is exactly what the controller hands it.
  const tree = join(root, "tree")
  mkdirSync(join(tree, "repo"), { recursive: true })
  writeFileSync(join(tree, "repo", "README.md"), text)
  const workspace = await captureWorkspaceDefinition(root, {
    source: { directory: "tree", include: ["repo/README.md"] },
    environmentLinks: [],
  })
  const handoff = {
    version: 2,
    workOrderId: WORK_ORDER,
    workspace: { sourceDigest: workspace.source.digest, environmentLinks: [] },
  }
  return { workspace, handoff }
}
const metadataOf = (handoff: unknown) => ({
  factoryWorkOrderId: WORK_ORDER,
  factoryStage: "intake",
  factoryDrafter: handoff,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drafter-config-"))
  delete process.env.FACTORY_DRAFTER_IMAGE
  delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
  vi.mocked(dockerSandbox).mockClear()
  vi.resetModules()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
  delete process.env.FACTORY_DRAFTER_IMAGE
})

const loadConfig = async () => (await import("../b4.config.ts")).default
const resolver = async () => {
  const workspace = (await loadConfig()).sandbox?.workspace
  if (typeof workspace !== "function")
    throw new Error("drafter config must resolve its workspace per thread")
  return workspace
}

describe("the drafter's workspace resolver", () => {
  it("serves the staged workspace its handoff names, verified, by digest", async () => {
    const { workspace, handoff } = await captured()
    const resolved = await (await resolver())(thread(metadataOf(handoff), workspace))
    expect("version" in resolved && resolved.version).toBe(1)
    expect((resolved as { source: { digest: string } }).source.digest).toBe(workspace.source.digest)
    expect((resolved as { baseline?: string }).baseline).toBeUndefined()
  })

  it("refuses, by name, a thread created with no handoff or with no staged workspace", async () => {
    const { workspace, handoff } = await captured()
    const resolve = await resolver()
    // A thread created by an older controller (a manifest on disk, no handoff) is refused at
    // admission: drain in-flight intakes before upgrading.
    await expect(resolve(thread({ factoryWorkOrderId: WORK_ORDER }, workspace))).rejects.toThrow(
      /factoryDrafter is required/,
    )
    await expect(resolve(thread(metadataOf(handoff)))).rejects.toThrow(
      `work order ${WORK_ORDER}'s intake thread was created without a staged workspace`,
    )
  })

  it("refuses a staged workspace that is not the one the handoff names, or has a baseline", async () => {
    const { workspace, handoff } = await captured()
    const other = await captured("# another\n")
    const resolve = await resolver()
    await expect(resolve(thread(metadataOf(handoff), other.workspace))).rejects.toThrow(
      /is not the one work order wo-0123456789abcdef names/,
    )
    await expect(
      resolve(thread(metadataOf(handoff), { ...workspace, baseline: "git" })),
    ).rejects.toThrow(/carries no baseline/)
  })

  it("trusts nothing in the metadata beyond a catalog-id string and a strictly parsed handoff", async () => {
    const { workspace, handoff } = await captured()
    const resolve = await resolver()
    for (const metadata of [
      { factoryDrafter: handoff },
      { factoryWorkOrderId: "../x", factoryDrafter: handoff },
      { factoryWorkOrderId: 7, factoryDrafter: handoff },
    ]) {
      await expect(resolve(thread(metadata, workspace))).rejects.toThrow(/factoryWorkOrderId/)
    }
  })

  it("refuses a handoff of another version, or with the workspace's files in it", async () => {
    const { workspace, handoff } = await captured()
    const resolve = await resolver()
    for (const drifted of [
      { ...handoff, version: 1 },
      { ...handoff, workspace: { ...handoff.workspace, source: workspace.source } },
    ])
      await expect(resolve(thread(metadataOf(drifted), workspace))).rejects.toThrow(
        /factoryDrafter is invalid/,
      )
  })

  it("refuses a handoff written for a different work order", async () => {
    const { workspace, handoff } = await captured()
    const resolve = await resolver()
    await expect(
      resolve(thread(metadataOf({ ...handoff, workOrderId: "wo-other" }), workspace)),
    ).rejects.toThrow(/names work order wo-other/)
  })
})

describe("the drafter's sandbox and permissions", () => {
  it("serves its threads' workspaces over its own port, behind src/thread-access.ts", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.workspaceRead).toBe("http")
    // And takes each thread's workspace at creation, over the same port, behind the same policy.
    expect(config.sandbox?.stagedWorkspaces).toBe(true)
    expect(existsSync(fileURLToPath(new URL("../src/thread-access.ts", import.meta.url)))).toBe(
      true,
    )
  })

  it("pins the digest-addressed base image unless FACTORY_DRAFTER_IMAGE overrides it", async () => {
    const { DRAFTER_IMAGE } = await import("../src/drafter-image.ts")
    expect(DRAFTER_IMAGE).toMatch(/^node:24-slim@sha256:[a-f0-9]{64}$/)
    const config = await loadConfig()
    expect(config.sandbox?.provider.name).toBe("docker")
    expect(vi.mocked(dockerSandbox).mock.calls.at(-1)?.[0]).toMatchObject({
      scope: "software-factory-drafter",
      image: DRAFTER_IMAGE,
    })

    process.env.FACTORY_DRAFTER_IMAGE = `node:24-slim@sha256:${"a".repeat(64)}`
    vi.resetModules()
    await loadConfig()
    expect(vi.mocked(dockerSandbox).mock.calls.at(-1)?.[0]).toMatchObject({
      image: process.env.FACTORY_DRAFTER_IMAGE,
    })
  })

  it("denies the network and bounds the container", async () => {
    const config = await loadConfig()
    expect(config.sandbox?.network).toEqual({ mode: "deny" })
    expect(config.sandbox?.resources).toEqual({ memoryMb: 1024, cpus: 1, timeoutMs: 60_000 })
  })

  it("never waits on a person: non-interactive, a bounded list of command starts", async () => {
    const config = await loadConfig()
    expect(config.permissions?.mode).toBe("non-interactive")
    expect(config.permissions?.allow).toEqual({
      bash: ["ls", "cat", "head", "tail", "grep", "wc", "sed -n", "nl"],
    })
    // `find -exec` / `find -delete` would make the list a fig leaf; the need is covered.
    expect(config.permissions?.allow?.bash).not.toContain("find")
    // A shell wrapper would admit anything behind it: the live run's drafter tried
    // `bash -lc "nl -ba ... | sed -n ..."`, and that stays denied.
    for (const wrapped of ['bash -lc "ls"', 'sh -c "ls"'])
      expect(config.permissions?.allow?.bash?.some((p) => wrapped.startsWith(p))).toBe(false)
    // `sed` only as `sed -n`: a bare `sed` entry would admit `sed -i` at the start of a line.
    expect(config.permissions?.allow?.bash).not.toContain("sed")
    expect(config.toolOutput?.previewLines).toBe(10)
  })
})

describe("the retired manifest directory", () => {
  it("is a boot error naming FACTORY_DRAFTER_MANIFEST_DIR, and the drafter boots without it", async () => {
    await expect(loadConfig()).resolves.toBeDefined()
    process.env.FACTORY_DRAFTER_MANIFEST_DIR = join(root, "manifests")
    vi.resetModules()
    await expect(loadConfig()).rejects.toThrow(/FACTORY_DRAFTER_MANIFEST_DIR is retired/)
  })
})
