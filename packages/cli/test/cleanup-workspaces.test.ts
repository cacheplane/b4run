import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import { createSourceBundle } from "@b4run/workspace/node"
import { expect, it } from "vitest"
import { cleanupWorkspaces } from "../src/lib/runtime/cleanup-workspaces.ts"
import { ManagedWorkspaceManager } from "../src/lib/runtime/managed-workspace-manager.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

it("requires exclusive ownership and retains metadata deletion recovery after physical cleanup", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-workspace-cleanup-"))
  const installation = openWorkspaceInstallation(appRoot)
  const physical = managedProviderFixture()
  const manager = new ManagedWorkspaceManager({
    installation,
    definition: {
      version: 1,
      source: createSourceBundle([{ path: "file", bytes: new Uint8Array([1]), executable: false }]),
      environmentLinks: [],
    },
    provider: physical.workspaces,
    policy: { network: { mode: "deny" } },
    idleTimeoutMs: 1000,
  })
  try {
    await manager.getForThread("one", new AbortController().signal)
    await expect(cleanupWorkspaces({ appRoot, provider: physical.provider })).rejects.toThrow(
      /locked|busy/i,
    )
    await manager.releaseAll()
    await cleanupWorkspaces({ appRoot, provider: physical.provider })
    expect(physical.records.size).toBe(0)
    const owner = openWorkspaceInstallation(appRoot)
    try {
      expect(owner.associations.get("one")?.state).toBe("deleting")
    } finally {
      owner.close()
    }
  } finally {
    await manager.releaseAll()
    await rm(appRoot, { recursive: true, force: true })
  }
})
