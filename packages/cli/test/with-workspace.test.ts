import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { withWorkspace } from "../src/lib/runtime/with-workspace.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function options() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-disposable-workspace-"))
  roots.push(appRoot)
  await mkdir(join(appRoot, "source"))
  await writeFile(join(appRoot, "source", "file"), "original")
  return {
    appRoot,
    stateRoot: join(appRoot, "private-state"),
    provider: managedProviderFixture().provider,
    workspace: { source: { directory: "source", include: ["file"] } },
    policy: { network: { mode: "deny" as const } },
  }
}
it("cleans successful and failed executions without leaking physical resources", async () => {
  const opts = await options()
  const physical = managedProviderFixture()
  opts.provider = physical.provider
  expect(
    await withWorkspace(opts, async (handle) =>
      handle.filesystem.readFile("/workspace/file", {
        workspaceRoot: "/workspace",
        signal: new AbortController().signal,
      }),
    ),
  ).toBe("original")
  expect(physical.records.size).toBe(0)
  await expect(
    withWorkspace(opts, async () => {
      throw undefined
    }),
  ).rejects.toBeUndefined()
  expect(physical.records.size).toBe(0)
})
it("recovers uncertain prior cleanup before invoking another callback", async () => {
  const opts = await options()
  const physical = managedProviderFixture()
  opts.provider = physical.provider
  const destroy = physical.workspaces.destroy
  physical.workspaces.destroy = async () => {
    throw new Error("cleanup unavailable")
  }
  await expect(withWorkspace(opts, async () => "done")).rejects.toThrow("cleanup unavailable")
  expect(physical.records.size).toBe(1)
  physical.workspaces.destroy = destroy
  await withWorkspace(opts, async () => {
    expect(physical.records.size).toBe(1)
  })
  expect(physical.records.size).toBe(0)
})
