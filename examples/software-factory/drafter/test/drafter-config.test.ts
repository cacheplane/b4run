import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerSandbox } from "@b4run/sandbox"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The drafter's config is a function of ONE input, FACTORY_DRAFTER_MANIFEST_DIR, and its
 * resolver of ONE thread fact, `metadata.factoryWorkOrderId`. These tests build the manifest
 * themselves with the framework's own capture rather than importing the controller: the
 * drafter package must be understood, typechecked and tested without the controller's source.
 */
vi.mock("@b4run/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/sandbox")>()
  return { ...actual, dockerSandbox: vi.fn(actual.dockerSandbox) }
})

const WORK_ORDER = "wo-0123456789abcdef"
const thread = (metadata: Readonly<Record<string, unknown>>) => ({
  threadId: "t-1",
  metadata,
  signal: new AbortController().signal,
})

let root: string
let manifestDir: string
let sourceDigest: string

async function writeManifest(overrides: Record<string, unknown> = {}) {
  // A tiny tree in the shape the controller stages: the repository under `repo/`, nothing
  // else, and no baseline. The capture is the framework's, so what the drafter verifies is
  // exactly what the controller will hand it.
  const tree = join(root, "tree")
  mkdirSync(join(tree, "repo"), { recursive: true })
  writeFileSync(join(tree, "repo", "README.md"), "# fixture\n")
  const workspace = await captureWorkspaceDefinition(root, {
    source: { directory: "tree", include: ["repo/README.md"] },
    environmentLinks: [],
  })
  sourceDigest = workspace.source.digest
  writeFileSync(
    join(manifestDir, `${WORK_ORDER}.json`),
    JSON.stringify({ version: 1, workOrderId: WORK_ORDER, workspace, ...overrides }),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drafter-config-"))
  manifestDir = join(root, "manifests")
  mkdirSync(manifestDir)
  process.env.FACTORY_DRAFTER_MANIFEST_DIR = manifestDir
  delete process.env.FACTORY_DRAFTER_IMAGE
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
  it("serves the work order's captured workspace, verified, by digest", async () => {
    await writeManifest()
    const resolved = await (await resolver())(thread({ factoryWorkOrderId: WORK_ORDER }))
    expect("version" in resolved && resolved.version).toBe(1)
    expect((resolved as { source: { digest: string } }).source.digest).toBe(sourceDigest)
    expect((resolved as { baseline?: string }).baseline).toBeUndefined()
  })

  it("refuses a work order with no manifest, naming it and the directory", async () => {
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: WORK_ORDER }))).rejects.toThrow(
      `no drafter manifest for ${WORK_ORDER}`,
    )
    await expect(resolve(thread({ factoryWorkOrderId: WORK_ORDER }))).rejects.toThrow(manifestDir)
  })

  it("trusts nothing in the metadata beyond a catalog-id string", async () => {
    await writeManifest()
    const resolve = await resolver()
    // Missing, a path that would escape the directory, and a non-string: each is refused
    // before any file is read, and the refusal names the key the client got wrong.
    for (const metadata of [{}, { factoryWorkOrderId: "../x" }, { factoryWorkOrderId: 7 }]) {
      await expect(resolve(thread(metadata))).rejects.toThrow(/factoryWorkOrderId/)
    }
  })

  it("refuses a manifest of another version", async () => {
    await writeManifest({ version: 2 })
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: WORK_ORDER }))).rejects.toThrow(/version/)
  })

  it("refuses a manifest written for a different work order", async () => {
    await writeManifest({ workOrderId: "wo-other" })
    const resolve = await resolver()
    await expect(resolve(thread({ factoryWorkOrderId: WORK_ORDER }))).rejects.toThrow(/workOrderId/)
  })
})

describe("the drafter's sandbox and permissions", () => {
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
      bash: ["ls", "cat", "head", "tail", "grep", "wc"],
    })
    // `find -exec` / `find -delete` would make the list a fig leaf; the need is covered.
    expect(config.permissions?.allow?.bash).not.toContain("find")
    expect(config.toolOutput?.previewLines).toBe(10)
  })
})

describe("a missing manifest directory", () => {
  it("is a boot error naming the variable", async () => {
    delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
    vi.resetModules()
    await expect(loadConfig()).rejects.toThrow(/FACTORY_DRAFTER_MANIFEST_DIR/)
  })

  it("tolerates an empty directory at boot: refusal happens per thread", async () => {
    const config = await loadConfig()
    expect(typeof config.sandbox?.workspace).toBe("function")
  })
})
