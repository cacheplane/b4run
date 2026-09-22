import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { openRegistry, RegistryVersionError, SCHEMA_VERSION } from "../src/lib/registry/db.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
// Cleared after every test: the tests that open neither must not re-close the previous
// test's fake or factory.
let fake: FakeWorker | undefined
let factory: Factory | undefined

function factoryOptions(dir: string, registryPath: string): FactoryOptions {
  return {
    registryPath,
    worker: createHttpWorkerClient(fake?.baseUrl ?? ""),
    workerRoute: "/build#agent",
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    workspaceReader: createFakeWorkspaceReader({}),
    captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
  }
}

afterEach(async () => {
  await factory?.close()
  await fake?.close()
  factory = undefined
  fake = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("registry reader", () => {
  it("reads rows, events and evidence while the writer holds the registry, and cannot write", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const registryPath = join(dir, "registry.sqlite")
    factory = await createFactory(factoryOptions(dir, registryPath))
    const row = await factory.create({ taskId: "cli-flags" })
    const reader = openRegistryReader(registryPath) // the writer is still open: WAL present
    try {
      expect(reader.show(row.id)?.state).toBe("received")
      expect(reader.list().map((r) => r.id)).toEqual([row.id])
      expect(reader.events(row.id).map((e) => e.type)).toContain("created")
      expect(reader.evidence(row.id)).toEqual({ candidate: null, receipt: null, bundle: null })
      expect(reader.show("nope")).toBeNull()
      expect(() => reader.evidence("nope")).toThrow(/Unknown work order/)
      expect(() => reader.db.exec("DELETE FROM work_orders")).toThrow(/readonly|read-only/i)
    } finally {
      reader.close()
    }
  })

  it("refuses to create a registry that does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    expect(() => openRegistryReader(join(dir, "missing.sqlite"))).toThrow(/does not exist/)
  })

  it("refuses a registry whose schema is newer than this factory", () => {
    // A copy so the original stays a registry this build can still open: the refusal has to
    // come from the version on disk, not from a file the test broke.
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    const registryPath = join(dir, "registry.sqlite")
    openRegistry(registryPath).close()
    const newer = join(dir, "newer.sqlite")
    copyFileSync(registryPath, newer)
    const writable = new DatabaseSync(newer)
    writable.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION + 1)
    writable.close()
    expect(() => openRegistryReader(newer)).toThrow(RegistryVersionError)
    // Reading the untouched original still works, so the refusal is about the version.
    openRegistryReader(registryPath).close()
  })

  it("names a database that is not a registry", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    const other = join(dir, "other.sqlite")
    const writable = new DatabaseSync(other)
    writable.exec("CREATE TABLE something (x INTEGER)")
    writable.close()
    expect(() => openRegistryReader(other)).toThrow(/is not a factory registry/)
  })

  it("closes idempotently", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    const registryPath = join(dir, "registry.sqlite")
    openRegistry(registryPath).close()
    const reader = openRegistryReader(registryPath)
    reader.close()
    expect(() => reader.close()).not.toThrow()
  })

  it("sees a row the writer committed after the reader opened", async () => {
    // WAL readers see committed writes on their next statement; the CLI relies on this to
    // tail events while a dispatch route is running.
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const registryPath = join(dir, "registry.sqlite")
    factory = await createFactory(factoryOptions(dir, registryPath))
    const reader = openRegistryReader(registryPath)
    try {
      expect(reader.list()).toEqual([])
      const row = await factory.create({ taskId: "cli-flags" })
      expect(reader.show(row.id)?.state).toBe("received")
    } finally {
      reader.close()
    }
  })
})
