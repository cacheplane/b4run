import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"
import { afterEach, expect, it } from "vitest"
import { openWorkspaceInstallation, openWorkspaceInstallationReader } from "../src/index.ts"

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "b4-thread-sandbox-"))
  roots.push(path)
  return path
}
const bundle = createSourceBundle([
  { path: "main.ts", bytes: new TextEncoder().encode("hello"), executable: false },
])
function intentFor(installationId: string, threadId: string) {
  return createWorkspaceIntent({
    operationId: randomUUID(),
    installationId,
    threadId,
    definition: { version: 1, source: bundle, environmentLinks: [] },
    environment: {
      binding: { provider: "fake", scope: "test", account: "local" },
      identity: "env-1",
    },
  })
}
const record: ThreadSandboxRecord = {
  version: 1,
  image: "factory:one",
  policy: { network: { mode: "deny" }, resources: { memoryMb: 512 } },
}

it("records a thread's sandbox with its association and reads it back after reopen", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  owner.sources.put(bundle)
  owner.associations.create(intentFor(owner.installationId, "one"), record)
  owner.associations.create(intentFor(owner.installationId, "two"))
  owner.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.threadSandboxes.get("one")).toEqual(record)
    expect(reopened.threadSandboxes.get("two")).toBeUndefined()
  } finally {
    reopened.close()
  }
})

it("writes no record when the association cannot be created", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    // No retained source: the association refuses, and the record goes with it.
    expect(() => owner.associations.create(intentFor(owner.installationId, "one"), record)).toThrow(
      /source/i,
    )
    expect(owner.associations.get("one")).toBeUndefined()
    expect(owner.threadSandboxes.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("writes no association when the record is invalid", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    const invalid = { version: 1, policy: { network: { mode: "deny", allowlist: ["10.0.0.0/8"] } } }
    expect(() =>
      owner.associations.create(intentFor(owner.installationId, "one"), invalid as never),
    ).toThrow(/not enforced/)
    expect(owner.associations.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("is idempotent for the same record and refuses another one", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    const intent = intentFor(owner.installationId, "one")
    owner.associations.create(intent, record)
    expect(owner.associations.create(intent, record).revision).toBe(1)
    expect(() => owner.associations.create(intent, { version: 1, image: "factory:two" })).toThrow(
      /thread sandbox conflict/i,
    )
    expect(() => owner.associations.create(intent)).toThrow(/thread sandbox conflict/i)
  } finally {
    owner.close()
  }
})

it("drops the record when the thread's deletion completes", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), record)
    const deleting = owner.associations.beginDelete("one")
    expect(owner.threadSandboxes.get("one")).toEqual(record)
    owner.associations.completeDelete("one", deleting?.revision ?? 0)
    expect(owner.threadSandboxes.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("adds its tables to an installation whose associations predate them, recording nothing for those", () => {
  // The upgrade path: an installation from before per-thread sandboxes has associations and
  // no tables. Opening it must work (every existing managed-workspace app upgrades through
  // here); its old threads simply have no record. In thread mode the MANAGER refuses such a
  // thread at admission (Task 5), which is what keeps a lost record from failing open.
  const path = root()
  const first = openWorkspaceInstallation(path)
  first.sources.put(bundle)
  first.associations.create(intentFor(first.installationId, "old"))
  first.close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes; DROP TABLE workspace_thread_sandbox_schema")
  db.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.associations.get("old")?.state).toBe("creating")
    expect(reopened.threadSandboxes.get("old")).toBeUndefined()
    reopened.associations.create(intentFor(reopened.installationId, "one"), record)
    expect(reopened.threadSandboxes.get("one")).toEqual(record)
  } finally {
    reopened.close()
  }
})

it("refuses a half-present schema", () => {
  const path = root()
  openWorkspaceInstallation(path).close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes")
  db.close()
  expect(() => openWorkspaceInstallation(path)).toThrow(
    /Incomplete workspace thread sandbox schema/,
  )
})

it("leaves the lock-free reader working beside the owner", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), record)
    const reader = openWorkspaceInstallationReader(path)
    try {
      expect(reader.associations.get("one")?.state).toBe("creating")
    } finally {
      reader.close()
    }
  } finally {
    owner.close()
  }
})

it("rolls the association back when the record's insert fails", () => {
  const path = root()
  openWorkspaceInstallation(path).close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec(
    "CREATE TRIGGER fail_record BEFORE INSERT ON workspace_thread_sandboxes BEGIN SELECT RAISE(ABORT, 'injected record failure'); END",
  )
  db.close()
  const owner = openWorkspaceInstallation(path)
  try {
    owner.sources.put(bundle)
    expect(() => owner.associations.create(intentFor(owner.installationId, "one"), record)).toThrow(
      /injected record failure/,
    )
    expect(owner.associations.get("one")).toBeUndefined()
    expect(owner.associations.list()).toEqual([])
    expect(owner.threadSandboxes.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

const scoped: ThreadSandboxRecord = { version: 1, permissions: { allow: { bash: ["ls"] } } }

it("keeps a thread's grants across reopen, idempotently, and only for a thread with its own permissions", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  owner.sources.put(bundle)
  owner.associations.create(intentFor(owner.installationId, "one"), scoped)
  owner.associations.create(intentFor(owner.installationId, "two"), record)
  owner.threadSandboxes.addGrant("one", "bash", "make")
  owner.threadSandboxes.addGrant("one", "bash", "make")
  owner.threadSandboxes.addGrant("one", "readFile", "/tmp/")
  expect(() => owner.threadSandboxes.addGrant("two", "bash", "make")).toThrow(
    /permissions of its own/,
  )
  expect(() => owner.threadSandboxes.addGrant("three", "bash", "make")).toThrow(
    /permissions of its own/,
  )
  owner.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.threadSandboxes.grants("one")).toEqual({ bash: ["make"], readFile: ["/tmp/"] })
    expect(reopened.threadSandboxes.grants("two")).toEqual({})
  } finally {
    reopened.close()
  }
})

it("refuses an empty or NUL-bearing grant", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), scoped)
    expect(() => owner.threadSandboxes.addGrant("one", "bash", "")).toThrow(/grant pattern/)
    expect(() => owner.threadSandboxes.addGrant("one", "", "ls")).toThrow(/grant tool/)
    expect(() => owner.threadSandboxes.addGrant("one", "bash", "a\u0000b")).toThrow(/grant pattern/)
    expect(owner.threadSandboxes.grants("one")).toEqual({})
  } finally {
    owner.close()
  }
})

it("drops a thread's grants with its record", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), scoped)
    owner.threadSandboxes.addGrant("one", "bash", "make")
    const deleting = owner.associations.beginDelete("one")
    owner.associations.completeDelete("one", deleting?.revision ?? 0)
    expect(owner.threadSandboxes.grants("one")).toEqual({})
  } finally {
    owner.close()
  }
})

it("adds the grants table to an installation whose record tables predate it", () => {
  const path = root()
  const first = openWorkspaceInstallation(path)
  first.sources.put(bundle)
  first.associations.create(intentFor(first.installationId, "one"), scoped)
  first.close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_permission_grants")
  db.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.threadSandboxes.grants("one")).toEqual({})
    reopened.threadSandboxes.addGrant("one", "bash", "make")
    expect(reopened.threadSandboxes.grants("one")).toEqual({ bash: ["make"] })
  } finally {
    reopened.close()
  }
})
