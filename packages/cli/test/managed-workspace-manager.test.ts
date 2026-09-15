import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeSandbox } from "@b4run/sandbox/testing"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type {
  ManagedWorkspaceProvider,
  ReadyWorkspace,
  SandboxHandle,
  WorkspaceCreateIntent,
} from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, expect, it, vi } from "vitest"
import { ManagedWorkspaceManager } from "../src/lib/runtime/managed-workspace-manager.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
const source = createSourceBundle([
  { path: "main.ts", bytes: new TextEncoder().encode("initial"), executable: false },
])
function fixture(root = mkdtempSync(join(tmpdir(), "b4-managed-manager-"))) {
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const physical = new Map<string, ReadyWorkspace>()
  const calls: string[] = []
  const legacy = fakeSandbox()
  const provider: ManagedWorkspaceProvider = {
    name: "managed-fake",
    async resolveEnvironment() {
      return {
        binding: { provider: "fake", scope: "scope", account: "service" },
        identity: "snapshot-1",
      }
    },
    async create(intent, _source) {
      calls.push("create")
      const ready: ReadyWorkspace = {
        reference: {
          version: 1,
          operationId: intent.operationId,
          installationId: intent.installationId,
          threadId: intent.threadId,
          intentDigest: intent.digest,
          resource: { id: randomUUID() },
        },
        provenance: {
          sourceDigest: intent.sourceDigest,
          environment: intent.environment,
          retention: { filesystem: "until-destroy", memory: "retained" },
        },
      }
      physical.set(intent.operationId, ready)
      return ready
    },
    async inspectCreation(intent) {
      calls.push("inspect")
      const workspace = physical.get(intent.operationId)
      return workspace ? { status: "ready", workspace } : { status: "absent" }
    },
    async reconnect(workspace, policy, signal) {
      calls.push("reconnect")
      expect(installation.associations.get(workspace.reference.threadId)?.state).toBe("ready")
      return {
        reference: { workspace: workspace.reference, incarnation: randomUUID() },
        handle: await legacy.acquire({ threadId: workspace.reference.threadId, policy, signal }),
      }
    },
    async release() {
      calls.push("release")
    },
    async destroy(target) {
      calls.push("destroy")
      physical.delete(target.intent.operationId)
    },
  }
  const definition = { version: 1 as const, source, environmentLinks: [] }
  const manager = new ManagedWorkspaceManager({
    installation,
    definition,
    provider,
    policy: { network: { mode: "deny" } },
    idleTimeoutMs: 0,
  })
  managers.push(manager)
  return { manager, installation, provider, physical, calls, root }
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.releaseAll()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("persists intent and readiness before exposing any tool backend", async () => {
  const { manager, installation, calls } = fixture()
  await manager.getForThread("one", new AbortController().signal)
  expect(installation.associations.get("one")?.state).toBe("ready")
  expect(calls).toEqual(["inspect", "create", "reconnect"])
  expect(manager.getWorkspace("one")?.source).toEqual(source)
})
it("never recreates a pending operation after an unknown outcome", async () => {
  const { manager, provider, calls, installation } = fixture()
  provider.inspectCreation = async () => ({ status: "unknown", reason: "service cannot tell" })
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /service cannot tell/,
  )
  expect(calls).not.toContain("create")
  expect(installation.associations.get("one")?.state).toBe("creating")
})
it("holds active use past abort delivery and prevents idle reaping or deletion", async () => {
  const { manager, calls } = fixture()
  const release = manager.retain("one")
  await manager.getForThread("one", new AbortController().signal)
  await manager.reapIdle()
  expect(calls).not.toContain("release")
  await expect(manager.destroyThread("one")).rejects.toThrow(/active/i)
  release()
  await manager.reapIdle()
  expect(calls).toContain("release")
})
it("keeps deletion durable through uncertain provider cleanup", async () => {
  const { manager, provider, installation } = fixture()
  await manager.getForThread("one", new AbortController().signal)
  const destroy = provider.destroy
  provider.destroy = async () => {
    throw new Error("uncertain cleanup")
  }
  await expect(manager.destroyThread("one")).rejects.toThrow("uncertain cleanup")
  expect(installation.associations.get("one")?.state).toBe("deleting")
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(/delet/)
  provider.destroy = destroy
  await manager.destroyThread("one")
  expect(installation.associations.get("one")?.state).toBe("deleting")
  manager.completeDelete("one")
  expect(installation.associations.get("one")?.state).toBe("deleted")
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(/delet/)
})
it("keeps trusted provenance separate between threads", async () => {
  const { manager } = fixture()
  await Promise.all(
    ["one", "two"].map((id) => manager.getForThread(id, new AbortController().signal)),
  )
  expect(manager.getWorkspace("one")?.ready.reference.operationId).not.toBe(
    manager.getWorkspace("two")?.ready.reference.operationId,
  )
  expect(manager.getWorkspace("missing")).toBeUndefined()
})
it("recovers pending preparation by resuming the same persisted operation", async () => {
  const { manager, provider, installation } = fixture()
  let operation: string | undefined
  provider.inspectCreation = async (intent) => {
    operation = intent.operationId
    return { status: "pending" }
  }
  await manager.getForThread("pending", new AbortController().signal)
  expect(installation.associations.get("pending")?.intent.operationId).toBe(operation)
})
it("rejects reconnect resource substitution", async () => {
  const { manager, provider } = fixture()
  const reconnect = provider.reconnect
  provider.reconnect = async (...args) => {
    const session = await reconnect(...args)
    return {
      ...session,
      reference: {
        ...session.reference,
        workspace: { ...session.reference.workspace, resource: { id: "foreign" } },
      },
    }
  }
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /mismatch/,
  )
})
it("reconciles durable deletion before completing its tombstone", async () => {
  const { manager, installation, calls } = fixture()
  await manager.getForThread("one", new AbortController().signal)
  installation.associations.beginDelete("one")
  await manager.reconcileDeletions(async (id) => {
    expect(id).toBe("one")
    expect(calls.at(-1)).toBe("destroy")
  })
  expect(installation.associations.get("one")?.state).toBe("deleted")
})
it("serializes backend calls and retains ownership until failed work settles", async () => {
  const { manager, provider, calls } = fixture()
  const reconnect = provider.reconnect
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let count = 0
  provider.reconnect = async (...args) => {
    const session = await reconnect(...args)
    return {
      ...session,
      handle: {
        ...session.handle,
        exec: {
          async runCommand() {
            count++
            if (count === 1) {
              started()
              await pending
              return { stdout: "", stderr: "failure", exitCode: 1 }
            }
            return { stdout: "next", stderr: "", exitCode: 0 }
          },
        },
      },
    }
  }
  const handle = await manager.getForThread("one", new AbortController().signal)
  const ctx = { signal: new AbortController().signal, workspaceRoot: handle.workspaceRoot }
  const first = handle.exec.runCommand({ command: "first" }, ctx)
  await entered
  const second = handle.exec.runCommand({ command: "second" }, ctx)
  await manager.reapIdle()
  await expect(manager.destroyThread("one")).rejects.toThrow(/active/)
  expect(count).toBe(1)
  expect(calls).not.toContain("release")
  finish()
  expect((await first).exitCode).toBe(1)
  expect((await second).stdout).toBe("next")
  expect(calls.filter((call) => call === "reconnect")).toHaveLength(2)
})

it("blocks cached backend use after the recorded retention deadline", async () => {
  const { manager, provider, calls } = fixture()
  const create = provider.create
  const expiry = Date.now() + 10000
  provider.create = async (...args) => {
    const ready = await create(...args)
    return {
      ...ready,
      provenance: {
        ...ready.provenance,
        retention: {
          filesystem: "expires",
          expiresAt: new Date(expiry).toISOString(),
          memory: "retained",
        },
      },
    }
  }
  const handle = await manager.getForThread("expiring", new AbortController().signal)
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1)
  try {
    await expect(
      handle.exec.runCommand(
        { command: "echo expired" },
        { workspaceRoot: handle.workspaceRoot, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/deadline|expired/)
    expect(calls.filter((call) => call === "create")).toHaveLength(1)
  } finally {
    clock.mockRestore()
  }
})
