import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  captureWorkspaceArtifact,
  threadSandboxArtifact,
  verifyWorkspaceArtifact,
  verifyWorkspaceResolverArtifact,
} from "../src/lib/build/workspace-artifact.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
it("retains initial source without needing the original directory at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  await mkdir(join(root, "fixture"))
  await writeFile(join(root, "fixture", "file.txt"), "original")
  const definition = { source: { directory: "fixture", include: ["file.txt"] } }
  const artifact = await captureWorkspaceArtifact(root, definition)
  await rm(join(root, "fixture"), { recursive: true })
  const restored = verifyWorkspaceArtifact(JSON.parse(JSON.stringify(artifact)), definition)
  expect(Buffer.from(restored.source.files[0]!.base64, "base64").toString()).toBe("original")
  expect(() =>
    verifyWorkspaceArtifact(artifact, { source: { directory: "other", include: ["file.txt"] } }),
  ).toThrow(/rebuild/i)
})
it("rejects corrupt artifact bytes and malformed descriptor accessors", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  await writeFile(join(root, "a"), "a")
  const definition = { source: { directory: ".", include: ["a"] } }
  const artifact = await captureWorkspaceArtifact(root, definition)
  if (artifact.version !== 1) throw new Error("expected a captured artifact")
  expect(() => verifyWorkspaceArtifact({ ...artifact, version: 2 }, definition)).toThrow()
  expect(() =>
    verifyWorkspaceArtifact(
      {
        ...artifact,
        workspace: {
          ...artifact.workspace,
          source: { ...artifact.workspace.source, digest: "0".repeat(64) },
        },
      },
      definition,
    ),
  ).toThrow()
  const bad = {
    get source() {
      throw new Error("getter ran")
    },
  }
  expect(() => verifyWorkspaceArtifact(artifact, bad as never)).toThrow(/descriptor/i)
})
it("records a resolver as a resolver, with no captured source", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  const resolver = async () => ({ source: { directory: ".", include: ["a"] } })
  const artifact = await captureWorkspaceArtifact(root, resolver)
  expect(artifact).toEqual({ version: 2, kind: "resolver" })
  expect(() =>
    verifyWorkspaceResolverArtifact(JSON.parse(JSON.stringify(artifact)), "resolver"),
  ).not.toThrow()
})

it("refuses to boot a static artifact under a resolver config, and the reverse", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  await writeFile(join(root, "a"), "a")
  const definition = { source: { directory: ".", include: ["a"] } }
  const staticArtifact = await captureWorkspaceArtifact(root, definition)
  const resolverArtifact = await captureWorkspaceArtifact(root, async () => definition)
  expect(() =>
    verifyWorkspaceResolverArtifact(JSON.parse(JSON.stringify(staticArtifact)), "resolver"),
  ).toThrow(/rebuild/i)
  expect(() =>
    verifyWorkspaceArtifact(JSON.parse(JSON.stringify(resolverArtifact)), definition),
  ).toThrow(/rebuild/i)
  expect(() => verifyWorkspaceResolverArtifact(null, "resolver")).toThrow(/rebuild/i)
  expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "other" }, "resolver")).toThrow(
    /rebuild/i,
  )
})

describe("thread sandbox artifact", () => {
  const definition = { source: { directory: ".", include: [] as string[] } }
  it("is a tagged record with nothing captured", () => {
    expect(threadSandboxArtifact()).toEqual({ version: 2, kind: "thread" })
    expect(Object.isFrozen(threadSandboxArtifact())).toBe(true)
  })
  it("verifies as its own form only", () => {
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "thread" }, "thread"),
    ).not.toThrow()
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "resolver" }, "resolver"),
    ).not.toThrow()
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "resolver" }, "thread"),
    ).toThrow(/configuration changed; rebuild/)
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "thread" }, "resolver"),
    ).toThrow(/configuration changed; rebuild/)
    expect(() => verifyWorkspaceArtifact({ version: 2, kind: "thread" }, definition)).toThrow(
      /configuration changed; rebuild/,
    )
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "other" }, "thread")).toThrow(
      /Invalid workspace build artifact/,
    )
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "thread", extra: 1 }, "thread"),
    ).toThrow(/Invalid workspace build artifact/)
  })
})
