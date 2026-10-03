import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createThreadPermissionsStore } from "@b4run/permissions"
import { createPermissionsStore } from "@b4run/permissions/node"
import { fakeSandbox } from "@b4run/sandbox/testing"
import { openWorkspaceInstallation, type WorkspaceInstallation } from "@b4run/sqlite-storage"
import {
  type CapturedWorkspaceDefinition,
  type ManagedWorkspaceProvider,
  type ReadyWorkspace,
  type SandboxHandle,
  type SandboxPolicy,
  type WorkspaceCreateIntent,
  WorkspaceLifecycleError,
} from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, expect, it, vi } from "vitest"
import {
  ManagedWorkspaceManager,
  type ResolvedThreadSandbox,
} from "../src/lib/runtime/managed-workspace-manager.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
const source = createSourceBundle([
  { path: "main.ts", bytes: new TextEncoder().encode("initial"), executable: false },
])
function makeProvider(
  installation: WorkspaceInstallation,
  physical: Map<string, ReadyWorkspace>,
  calls: string[],
): ManagedWorkspaceProvider {
  const legacy = fakeSandbox()
  return {
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
}
function fixture(root = mkdtempSync(join(tmpdir(), "b4-managed-manager-"))) {
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const physical = new Map<string, ReadyWorkspace>()
  const calls: string[] = []
  const provider = makeProvider(installation, physical, calls)
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

it("verifies the stored source once per admitted session, not once per backend call", async () => {
  const { manager, installation } = fixture()
  const read = vi.spyOn(installation.sources, "get")
  const signal = new AbortController().signal
  const handle = await manager.getForThread("one", signal)
  expect(read).toHaveBeenCalledTimes(1)
  const ctx = { signal, workspaceRoot: handle.workspaceRoot }
  for (let i = 0; i < 20; i++) {
    await handle.filesystem.writeFile(`note-${i}.txt`, "x", ctx)
    await handle.filesystem.readFile(`note-${i}.txt`, ctx)
    await manager.getForThread("one", signal)
  }
  expect(read).toHaveBeenCalledTimes(1)
  // A new session is a new admission: the stored bundle is read and verified again.
  await manager.reapIdle()
  await manager.getForThread("one", signal)
  expect(read).toHaveBeenCalledTimes(2)
})

it("refuses a tampered stored source at the next admission", async () => {
  const { manager, root } = fixture()
  const signal = new AbortController().signal
  const handle = await manager.getForThread("one", signal)
  const db = new DatabaseSync(join(root, ".b4/workspaces/state.sqlite"))
  try {
    const row = db.prepare("SELECT digest, payload FROM workspace_sources").get() as {
      digest: string
      payload: string
    }
    const initial = Buffer.from("initial").toString("base64")
    const forged = Buffer.from("hacked!").toString("base64")
    expect(row.payload).toContain(initial)
    db.prepare("UPDATE workspace_sources SET payload=? WHERE digest=?").run(
      row.payload.replace(initial, forged),
      row.digest,
    )
  } finally {
    db.close()
  }
  // The live session keeps the bundle it was verified with, not the forged row.
  expect(new TextDecoder().decode(manager.getWorkspace("one")?.readInitialFile("main.ts"))).toBe(
    "initial",
  )
  await handle.filesystem.writeFile("still.txt", "ok", {
    signal,
    workspaceRoot: handle.workspaceRoot,
  })
  await manager.reapIdle()
  await expect(manager.getForThread("one", signal)).rejects.toThrow(/digest mismatch/)
  expect(manager.getWorkspace("one")).toBeUndefined()
})

it("reads initial files by path and still rejects unknown or invalid paths", async () => {
  const { manager } = fixture()
  await manager.getForThread("one", new AbortController().signal)
  const workspace = manager.getWorkspace("one")
  expect(new TextDecoder().decode(workspace?.readInitialFile("main.ts"))).toBe("initial")
  expect(() => workspace?.readInitialFile("missing.ts")).toThrow(/Missing source file/)
  expect(() => workspace?.readInitialFile("../main.ts")).toThrow()
})

function resolverFixture(
  captureDefinition: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<CapturedWorkspaceDefinition>,
) {
  const root = mkdtempSync(join(tmpdir(), "b4-managed-resolver-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const physical = new Map<string, ReadyWorkspace>()
  const calls: string[] = []
  const provider = makeProvider(installation, physical, calls)
  const manager = new ManagedWorkspaceManager({
    installation,
    provider,
    policy: { network: { mode: "deny" } },
    idleTimeoutMs: 0,
    captureDefinition,
  })
  managers.push(manager)
  return { manager, installation, calls }
}

function bundle(text: string) {
  return createSourceBundle([
    { path: "main.ts", bytes: new TextEncoder().encode(text), executable: false },
  ])
}

it("calls the resolver once per thread, at first admission only", async () => {
  const seen: string[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(`${thread.threadId}:${String(thread.metadata.task)}`)
    return { version: 1, source: bundle(String(thread.metadata.task)), environmentLinks: [] }
  })
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "alpha" }) })
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "changed" }) })
  const handle = await manager.getForThread("one", signal)
  // Exercises the proxy's re-admission path (it must not invoke the resolver
  // again). A backend call that fails would invalidate the cached session, so
  // this uses the fake sandbox's default no-op exec rather than a filesystem
  // read (the fake sandbox's volume is never seeded from the source bundle).
  await handle.exec.runCommand({ command: "noop" }, { signal, workspaceRoot: handle.workspaceRoot })
  expect(seen).toEqual(["one:alpha"])
  expect(new TextDecoder().decode(manager.getWorkspace("one")?.readInitialFile("main.ts"))).toBe(
    "alpha",
  )
})

it("gives two threads different sources from their own metadata", async () => {
  const { manager, installation } = resolverFixture(async (thread) => ({
    version: 1,
    source: bundle(String(thread.metadata.task)),
    environmentLinks: [],
  }))
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "alpha" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ task: "beta" }) })
  const one = installation.associations.get("one")!.intent.sourceDigest
  const two = installation.associations.get("two")!.intent.sourceDigest
  expect(one).not.toBe(two)
  expect(new TextDecoder().decode(manager.getWorkspace("two")?.readInitialFile("main.ts"))).toBe(
    "beta",
  )
})

it("hands the resolver the admission signal", async () => {
  const controller = new AbortController()
  const seen: AbortSignal[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.signal)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", controller.signal)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toBe(controller.signal)
})

it("passes an empty metadata object when the runtime has none", async () => {
  const seen: unknown[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.metadata)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", new AbortController().signal)
  expect(seen).toEqual([{}])
  expect(Object.isFrozen(seen[0])).toBe(true)
})

it("freezes the metadata handed to the resolver, even a live store row", async () => {
  const liveRow: Record<string, unknown> = { taskId: "t-1" }
  const seen: unknown[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.metadata)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", new AbortController().signal, {
    metadata: async () => liveRow,
  })
  expect(Object.isFrozen(seen[0])).toBe(true)
  expect(() => {
    ;(seen[0] as Record<string, unknown>).taskId = "tampered"
  }).toThrow()
  // The resolver's copy is frozen; the store's own row is untouched by that attempt.
  expect(liveRow.taskId).toBe("t-1")
})

it("treats a non-object metadata loader result as no metadata", async () => {
  const seen: unknown[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.metadata)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", new AbortController().signal, {
    metadata: async () => "not-an-object" as never,
  })
  expect(seen).toEqual([{}])
})

it("resolves once when two first admissions of the same thread overlap", async () => {
  let resolverCalls = 0
  const { manager, calls } = resolverFixture(async () => {
    resolverCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  const signal = new AbortController().signal
  await Promise.all([manager.getForThread("one", signal), manager.getForThread("one", signal)])
  expect(resolverCalls).toBe(1)
  expect(calls.filter((call) => call === "create")).toHaveLength(1)
})

it("leaves no association or source when the admission is aborted during the resolver", async () => {
  const controller = new AbortController()
  const { manager, installation, calls } = resolverFixture(async (thread) => {
    controller.abort()
    thread.signal.throwIfAborted()
    return { version: 1, source: bundle("never"), environmentLinks: [] }
  })
  await expect(manager.getForThread("one", controller.signal)).rejects.toThrow()
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
})

it("leaves no source when the resolver ignores the abort signal", async () => {
  const controller = new AbortController()
  const { manager, installation, calls } = resolverFixture(async () => {
    controller.abort()
    return { version: 1, source: bundle("ignored"), environmentLinks: [] }
  })
  await expect(manager.getForThread("one", controller.signal)).rejects.toThrow()
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
  expect(installation.sources.get(bundle("ignored").digest)).toBeUndefined()
})

it("leaves no association and calls no provider when the resolver throws", async () => {
  const { manager, installation, calls } = resolverFixture(async () => {
    throw new Error("no task for this thread")
  })
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /no task for this thread/,
  )
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
})

it("rejects a resolver result that is not a captured definition before any provider call", async () => {
  const { manager, installation, calls } = resolverFixture(
    async () => ({ version: 1, source: bundle("x") }) as never,
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow()
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
})

it("refuses to construct with neither a definition nor a resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "b4-managed-none-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const provider = makeProvider(installation, new Map(), [])
  expect(
    () =>
      new ManagedWorkspaceManager({
        installation,
        provider,
        policy: { network: { mode: "deny" } },
        idleTimeoutMs: 0,
      }),
  ).toThrow(/definition or a resolver/i)
  installation.close()
})

function threadFixture(
  resolveThread: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<ResolvedThreadSandbox>,
  options: {
    readonly root?: string
    readonly refuse?: (image: string) => boolean
    readonly imageSupport?: boolean
    readonly appPolicy?: SandboxPolicy
  } = {},
) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  if (options.root === undefined) roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const physical = new Map<string, ReadyWorkspace>()
  const calls: string[] = []
  const base = makeProvider(installation, physical, calls)
  const policies = new Map<string, SandboxPolicy>()
  const provider: ManagedWorkspaceProvider = {
    ...base,
    async reconnect(workspace, policy, signal) {
      policies.set(workspace.reference.threadId, policy)
      return base.reconnect(workspace, policy, signal)
    },
    ...(options.imageSupport === false
      ? {}
      : {
          async resolveImageEnvironment(image: string) {
            calls.push(`image:${image}`)
            if (options.refuse?.(image))
              throw new WorkspaceLifecycleError("unsupported", `Image ${image} is not allowed`)
            return {
              binding: { provider: "fake", scope: "scope", account: "service" },
              identity: `snapshot@${image}`,
            }
          },
        }),
  }
  const manager = new ManagedWorkspaceManager({
    installation,
    provider,
    policy: options.appPolicy ?? { network: { mode: "deny" }, resources: { memoryMb: 1024 } },
    idleTimeoutMs: 0,
    resolveThread,
  })
  managers.push(manager)
  return { manager, installation, calls, policies, root }
}

const captured = (text: string): CapturedWorkspaceDefinition => ({
  version: 1,
  source: bundle(text),
  environmentLinks: [],
})

it("gives two threads their own image and policy, and reconnects each under its own", async () => {
  const { manager, installation, policies } = threadFixture(async (thread) =>
    thread.metadata.target === "b"
      ? {
          definition: captured("b"),
          image: "factory:b",
          policy: { resources: { memoryMb: 4096, cpus: 4 } },
        }
      : { definition: captured("a"), image: "factory:a", policy: { env: { TARGET: "a" } } },
  )
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ target: "a" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ target: "b" }) })
  expect(installation.associations.get("one")?.intent.environment.identity).toBe(
    "snapshot@factory:a",
  )
  expect(installation.associations.get("two")?.intent.environment.identity).toBe(
    "snapshot@factory:b",
  )
  expect(policies.get("one")).toEqual({
    network: { mode: "deny" },
    env: { TARGET: "a" },
    resources: { memoryMb: 1024 },
  })
  expect(policies.get("two")).toEqual({
    network: { mode: "deny" },
    resources: { memoryMb: 4096, cpus: 4 },
  })
  expect(installation.threadSandboxes.get("one")).toEqual({
    version: 1,
    image: "factory:a",
    policy: { env: { TARGET: "a" } },
  })
})

it("re-admits after a restart from the record, never calling the resolver again", async () => {
  let resolved = 0
  const first = threadFixture(async () => {
    resolved += 1
    return {
      definition: captured("a"),
      image: "factory:a",
      policy: { resources: { memoryMb: 2048 } },
    }
  })
  const signal = new AbortController().signal
  await first.manager.getForThread("one", signal)
  await first.manager.releaseAll()
  const second = threadFixture(
    async () => {
      throw new Error("the resolver must not run on re-admission")
    },
    { root: first.root },
  )
  await second.manager.getForThread("one", signal)
  expect(resolved).toBe(1)
  expect(second.policies.get("one")).toEqual({
    network: { mode: "deny" },
    resources: { memoryMb: 2048 },
  })
  expect(second.calls).toEqual(["reconnect"])
})

it("refuses an image the provider does not allow before creating anything", async () => {
  const { manager, installation, calls } = threadFixture(
    async () => ({ definition: captured("a"), image: "evil:latest" }),
    { refuse: (image) => image.startsWith("evil") },
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
  })
  expect(calls).toEqual(["image:evil:latest"])
  expect(installation.associations.get("one")).toBeUndefined()
  expect(installation.threadSandboxes.get("one")).toBeUndefined()
  expect(installation.sources.get(bundle("a").digest)).toBeUndefined()
})

it("refuses a per-thread image on a provider that cannot select one", async () => {
  const { manager, installation, calls } = threadFixture(
    async () => ({ definition: captured("a"), image: "factory:a" }),
    { imageSupport: false },
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /cannot run a per-thread image/,
  )
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
})

it("refuses a thread policy that opens the network the app denies, before any provider call", async () => {
  const { manager, installation, calls } = threadFixture(async () => ({
    definition: captured("a"),
    policy: { network: { mode: "allow" } },
  }))
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /may not open the network/,
  )
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
})

it("keeps the app's policy for a thread whose resolver set none", async () => {
  const { manager, policies, calls } = threadFixture(async () => ({
    definition: captured("a"),
  }))
  await manager.getForThread("one", new AbortController().signal)
  expect(policies.get("one")).toEqual({ network: { mode: "deny" }, resources: { memoryMb: 1024 } })
  expect(calls).toEqual(["inspect", "create", "reconnect"])
})

it("resolves a thread's sandbox once when two first admissions overlap", async () => {
  let resolved = 0
  const { manager, installation } = threadFixture(async () => {
    resolved += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { definition: captured("a"), image: "factory:a" }
  })
  const signal = new AbortController().signal
  await Promise.all([manager.getForThread("one", signal), manager.getForThread("one", signal)])
  expect(resolved).toBe(1)
  expect(installation.associations.list().map((entry) => entry.intent.threadId)).toEqual(["one"])
  expect(installation.threadSandboxes.get("one")).toEqual({ version: 1, image: "factory:a" })
})

it("records every thread it admits, { version: 1 } when the resolver chose nothing", async () => {
  const { manager, installation } = threadFixture(async () => ({ definition: captured("a") }))
  await manager.getForThread("one", new AbortController().signal)
  expect(installation.threadSandboxes.get("one")).toEqual({ version: 1 })
})

it("refuses a thread admitted before the app resolved sandboxes per thread", async () => {
  // The app ran with a static workspace, then switched to sandbox.thread: its old thread has an
  // association and no sandbox record, and must not run under the app's defaults silently.
  const root = mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  roots.push(root)
  const before = fixture(root)
  await before.manager.getForThread("one", new AbortController().signal)
  await before.manager.releaseAll()
  let resolved = 0
  const after = threadFixture(
    async () => {
      resolved += 1
      return { definition: captured("a") }
    },
    { root },
  )
  await expect(
    after.manager.getForThread("one", new AbortController().signal),
  ).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringMatching(/thread one has no sandbox record/i),
  })
  expect(resolved).toBe(0)
  expect(after.calls).toEqual([])
})

it("refuses a thread whose record was lost with its table", async () => {
  const first = threadFixture(async () => ({ definition: captured("a"), image: "factory:a" }))
  await first.manager.getForThread("one", new AbortController().signal)
  await first.manager.releaseAll()
  const db = new DatabaseSync(join(first.root, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes; DROP TABLE workspace_thread_sandbox_schema")
  db.close()
  // Reopening recreates the tables empty (the upgrade path); admission is what refuses.
  const second = threadFixture(async () => ({ definition: captured("a") }), { root: first.root })
  await expect(
    second.manager.getForThread("one", new AbortController().signal),
  ).rejects.toMatchObject({
    code: "conflict",
  })
  expect(second.calls).toEqual([])
})

it("refuses a thread resolver beside a workspace definition or resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  try {
    const provider = makeProvider(installation, new Map(), [])
    const common = {
      installation,
      provider,
      policy: { network: { mode: "deny" as const } },
      idleTimeoutMs: 0,
    }
    const resolveThread = async () => ({ definition: captured("a") })
    expect(
      () => new ManagedWorkspaceManager({ ...common, resolveThread, definition: captured("a") }),
    ).toThrow(/exclusive/)
    expect(
      () =>
        new ManagedWorkspaceManager({
          ...common,
          resolveThread,
          captureDefinition: async () => captured("a"),
        }),
    ).toThrow(/exclusive/)
  } finally {
    installation.close()
  }
})

it("refuses at reconnect a thread whose network the app has since denied", async () => {
  const first = threadFixture(
    async () => ({ definition: captured("a"), policy: { network: { mode: "allow" } } }),
    { appPolicy: { network: { mode: "allow" } } },
  )
  await first.manager.getForThread("one", new AbortController().signal)
  expect(first.policies.get("one")?.network).toEqual({ mode: "allow" })
  await first.manager.releaseAll()
  const second = threadFixture(
    async () => {
      throw new Error("the resolver must not run on re-admission")
    },
    { root: first.root, appPolicy: { network: { mode: "deny" } } },
  )
  await expect(second.manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /may not open the network/,
  )
  expect(second.calls).toEqual([])
})

it("refuses a record too large to store before any provider call or source row", async () => {
  const env = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`V${i}`, "x".repeat(30_000)]),
  )
  const { manager, installation, calls } = threadFixture(async () => ({
    definition: captured("big"),
    image: "factory:a",
    policy: { env },
  }))
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringMatching(/exceeds/),
  })
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
  expect(installation.sources.get(bundle("big").digest)).toBeUndefined()
})

it("allows a command in one thread that it denies in the other", async () => {
  const { manager } = threadFixture(async (thread) => ({
    definition: captured(String(thread.metadata.target)),
    permissions:
      thread.metadata.target === "a"
        ? { allow: { bash: ["npm test"] } }
        : { allow: { bash: ["make"] } },
  }))
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ target: "a" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ target: "b" }) })
  const app = createPermissionsStore({
    appRoot: tmpdir(),
    config: undefined,
    mode: "non-interactive",
  })
  const storeFor = async (threadId: string) => {
    const scoped = manager.threadPermissions(threadId)
    if (!scoped) throw new Error(`no permissions recorded for ${threadId}`)
    const store = createThreadPermissionsStore({ base: app, ...scoped })
    await store.load()
    return store
  }
  expect((await storeFor("one")).match("bash", "npm test")).toBe("allow")
  expect((await storeFor("two")).match("bash", "npm test")).toBe("unknown")
  expect((await storeFor("two")).match("bash", "make all")).toBe("allow")
})

it("keeps a thread's Always grant in its record across restart, never in .b4/permissions.json", async () => {
  const first = threadFixture(async () => ({
    definition: captured("a"),
    permissions: { allow: {} },
  }))
  const signal = new AbortController().signal
  await first.manager.getForThread("one", signal)
  const app = createPermissionsStore({
    appRoot: first.root,
    config: undefined,
    mode: "interactive",
  })
  await app.load()
  const scoped = first.manager.threadPermissions("one")
  if (!scoped) throw new Error("no permissions recorded")
  const store = createThreadPermissionsStore({ base: app, ...scoped })
  await store.load()
  await store.addAllow("bash", "make")
  expect(existsSync(join(first.root, ".b4", "permissions.json"))).toBe(false)
  await first.manager.releaseAll()
  const second = threadFixture(
    async () => {
      throw new Error("the resolver must not run on re-admission")
    },
    { root: first.root },
  )
  await second.manager.getForThread("one", signal)
  expect(second.manager.threadPermissions("one")?.grants.list()).toEqual({ bash: ["make"] })
})

it("has no thread permissions for a thread whose resolver set none", async () => {
  const { manager } = threadFixture(async () => ({ definition: captured("a") }))
  await manager.getForThread("one", new AbortController().signal)
  expect(manager.threadPermissions("one")).toBeUndefined()
})

it("refuses a thread's permissions when its record is gone, never falling back to the app's", async () => {
  const { manager, root } = threadFixture(async () => ({
    definition: captured("a"),
    permissions: { allow: { bash: ["npm test"] } },
  }))
  await manager.getForThread("one", new AbortController().signal)
  expect(manager.threadPermissions("one")?.permissions).toEqual({ allow: { bash: ["npm test"] } })
  const db = new DatabaseSync(join(root, ".b4", "workspaces", "state.sqlite"))
  db.exec("DELETE FROM workspace_thread_sandboxes WHERE thread_id='one'")
  db.close()
  // The cached session still serves getForThread; the permission read is what must refuse.
  await manager.getForThread("one", new AbortController().signal)
  expect(() => manager.threadPermissions("one")).toThrow(
    expect.objectContaining({
      code: "conflict",
      message: expect.stringMatching(/thread one has no sandbox record/i),
    }),
  )
  // A thread never admitted in thread mode has no record either: refused, not the app's store.
  expect(() => manager.threadPermissions("never")).toThrow(/no sandbox record/)
})

it("refuses an empty permission pattern before any provider call", async () => {
  const { manager, calls, installation } = threadFixture(async () => ({
    definition: captured("a"),
    permissions: { allow: { bash: [""] } },
  }))
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /empty pattern matches every candidate/,
  )
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
})

it("counts a thread's permissions toward its record size", async () => {
  const { manager, calls } = threadFixture(async () => ({
    definition: captured("a"),
    permissions: {
      allow: { bash: Array.from({ length: 100 }, (_, i) => `${i}${"x".repeat(4000)}`) },
    },
  }))
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringMatching(/sandbox record exceeds/),
  })
  expect(calls).toEqual([])
})
