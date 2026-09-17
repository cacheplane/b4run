import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { openRegistry, RegistryVersionError, SCHEMA_VERSION } from "../src/registry/db.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "factory-registry-"))
  dirs.push(dir)
  return join(dir, "nested", "registry.sqlite")
}

describe("openRegistry", () => {
  it("creates the file, the tables, and the version row", () => {
    const registry = openRegistry(tempPath())
    const tables = registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([
      "approvals",
      "commands",
      "deliveries",
      "events",
      "schema_version",
      "sqlite_sequence",
      "work_orders",
    ])
    const version = registry.db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
      v: number
    }
    expect(version.v).toBe(SCHEMA_VERSION)
    registry.close()
  })

  it("reopens an existing registry without re-running migrations", () => {
    const path = tempPath()
    openRegistry(path).close()
    const registry = openRegistry(path)
    const rows = registry.db.prepare("SELECT count(*) AS n FROM schema_version").get() as {
      n: number
    }
    expect(rows.n).toBe(1)
    registry.close()
  })

  it("refuses a registry written by a newer schema", () => {
    const path = tempPath()
    openRegistry(path).close()
    const db = new DatabaseSync(path)
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION + 1)
    db.close()
    expect(() => openRegistry(path)).toThrow(RegistryVersionError)
  })
})
