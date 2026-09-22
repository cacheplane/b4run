import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

function factoryOptions(dir: string, registryPath: string): FactoryOptions {
  return {
    registryPath,
    worker: createHttpWorkerClient(fake.baseUrl),
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
