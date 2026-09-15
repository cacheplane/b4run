import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  captureWorkspaceArtifact,
  verifyWorkspaceArtifact,
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
