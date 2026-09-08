import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteMemoryStore } from "@b4run/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { classifyChange } from "../src/lib/dev/classify-change.ts"
import { resolvePermissionsStore } from "../src/lib/runtime/execute-route.ts"
import { resolveMemoryStore, resolveMemoryWrites } from "../src/lib/runtime/resolve-memory.ts"

const tempDirs: string[] = []

async function createApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-state-contract-"))
  tempDirs.push(appRoot)
  await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n')
  return appRoot
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("B4 runtime state contract", () => {
  it("creates the default memory database under .b4", async () => {
    const appRoot = await createApp()
    const store = await resolveMemoryStore(appRoot)
    expect(await store.get("missing-record")).toBeNull()

    expect(existsSync(join(appRoot, ".b4", "memory.sqlite"))).toBe(true)
    // The old state location is intentionally retained as a negative assertion.
    expect(existsSync(join(appRoot, ".dawn"))).toBe(false)
  })

  it("leaves populated legacy memory untouched while writing fresh B4 state", async () => {
    const appRoot = await createApp()
    // These paths intentionally preserve the old state directory as a fixture.
    const legacyPath = join(appRoot, ".dawn", "memory.sqlite")
    const legacyStore = sqliteMemoryStore({ path: legacyPath })
    const legacyRecord = {
      id: "legacy-only",
      kind: "semantic" as const,
      namespace: "contract",
      content: "memory retained in the old application",
      data: {},
      source: { type: "run" as const, id: "legacy-run" },
      confidence: 1,
      tags: [],
      status: "active" as const,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    }
    await legacyStore.put(legacyRecord)
    const legacyFiles = [legacyPath, `${legacyPath}-wal`]
    const originalBytes = await Promise.all(legacyFiles.map((path) => readFile(path)))

    const store = await resolveMemoryStore(appRoot)
    expect(await store.get(legacyRecord.id)).toBeNull()
    const newRecord = { ...legacyRecord, id: "b4-only", content: "new application memory" }
    await store.put(newRecord)

    expect(await store.get(newRecord.id)).toEqual(newRecord)
    expect(existsSync(join(appRoot, ".b4", "memory.sqlite"))).toBe(true)
    expect(await legacyStore.get(legacyRecord.id)).toEqual(legacyRecord)
    expect(await legacyStore.get(newRecord.id)).toBeNull()
    expect(await Promise.all(legacyFiles.map((path) => readFile(path)))).toEqual(originalBytes)
  })

  it.each([
    ["B4_PERMISSIONS_MODE", "non-interactive"],
    // An old-name-only environment must not override the authored mode.
    ["DAWN_PERMISSIONS_MODE", "interactive"],
  ])("resolves permission mode with only %s configured", async (variable, expectedMode) => {
    const appRoot = await createApp()
    await writeFile(
      join(appRoot, "b4.config.ts"),
      'export default { permissions: { mode: "interactive" } }\n',
    )
    vi.stubEnv("B4_PERMISSIONS_MODE", undefined)
    vi.stubEnv("DAWN_PERMISSIONS_MODE", undefined)
    vi.stubEnv(variable, "non-interactive")

    const store = await resolvePermissionsStore(appRoot)
    expect(store.mode).toBe(expectedMode)
  })

  it("reads runtime settings from b4.config.ts", async () => {
    const appRoot = await createApp()
    await writeFile(
      join(appRoot, "b4.config.ts"),
      'export default { memory: { writes: "auto" } }\n',
    )

    expect(await resolveMemoryWrites(appRoot)).toBe("auto")
  })

  it("ignores runtime settings in the legacy config filename", async () => {
    const appRoot = await createApp()
    // This literal must remain unchanged: accepting it would restore an alias.
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      'export default { memory: { writes: "auto" } }\n',
    )

    expect(await resolveMemoryWrites(appRoot)).toBe("candidate")
  })

  it.each([".b4", ".b4/memory.sqlite", ".b4/checkpoints.sqlite-wal", ".b4/threads.sqlite"])(
    "does not restart the development server when %s changes",
    (path) => {
      expect(classifyChange(path)).toBe("ignore")
    },
  )
})
