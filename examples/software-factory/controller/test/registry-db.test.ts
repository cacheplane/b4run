import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import {
  MIGRATIONS,
  openRegistry,
  RegistryVersionError,
  SCHEMA_VERSION,
} from "../src/lib/registry/db.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

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
  it("carries no candidate_verified column: the worker never reports its own verdict", () => {
    // The rung 0 field the worker wrote its claimed verdict into. Rung 1 deleted every channel
    // by which a worker could claim its result; a column that survives, always null, is the
    // likeliest thing for a reader to mistake for one.
    const registry = openRegistry(tempPath())
    const columns = (
      registry.db.prepare("PRAGMA table_info(work_orders)").all() as { name: string }[]
    ).map((c) => c.name)
    expect(columns).not.toContain("candidate_verified")
    expect(SCHEMA_VERSION).toBe(4)
    registry.close()
  })

  it("creates the file, the tables, and the version row", () => {
    const registry = openRegistry(tempPath())
    const tables = registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([
      "approvals",
      "bundles",
      "candidates",
      "commands",
      "deliveries",
      "events",
      "receipts",
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
    expect(rows.n).toBe(SCHEMA_VERSION)
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

describe("migration 2", () => {
  it("creates the evidence tables and the approval binding", () => {
    const registry = openRegistry(tempPath())
    const tables = registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    for (const name of ["candidates", "receipts", "bundles"])
      expect(tables.map((t) => t.name)).toContain(name)
    const cols = registry.db.prepare("SELECT name FROM pragma_table_info('approvals')").all() as {
      name: string
    }[]
    expect(cols.map((c) => c.name)).toContain("bundle_digest")
    const wo = registry.db.prepare("SELECT name FROM pragma_table_info('work_orders')").all() as {
      name: string
    }[]
    expect(wo.map((c) => c.name)).toContain("bundle_digest")
    registry.close()
  })

  it("still refuses a newer schema", () => {
    const path = tempPath()
    openRegistry(path).close()
    const db = new DatabaseSync(path)
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION + 1)
    db.close()
    expect(() => openRegistry(path)).toThrow(RegistryVersionError)
  })
})

describe("migration 4", () => {
  it("upgrades a schema-3 registry and reads its rows as catalog work orders", () => {
    // A registry exactly as schema 3 left it: the first three migrations by hand, a version
    // row per migration, and one work order with only the schema-3 columns.
    const path = tempPath()
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
    for (const migration of MIGRATIONS.slice(0, 3)) {
      db.exec(migration.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(migration.version)
    }
    const at = "2026-09-16T00:00:00.000Z"
    db.prepare(
      `INSERT INTO work_orders (id, revision, state, task_id, worker_route, max_candidate_attempts,
         max_active_ms, active_ms, created_at, updated_at)
       VALUES ('wo-legacy', 0, 'received', 'cli-flags', '/build#agent', 1, 60000, 0, ?, ?)`,
    ).run(at, at)
    db.close()

    const registry = openRegistry(path)
    const version = registry.db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
      v: number
    }
    expect(version.v).toBe(4)
    const expected = {
      origin: { kind: "catalog" },
      pin: null,
      targetId: null,
      taskDigest: null,
      intakeAttempts: 0,
      maxIntakeAttempts: 2,
    }
    const row = createWorkOrderStore(registry.db).get("wo-legacy")
    expect(row).toMatchObject(expected)
    expect(row?.state).toBe("received")
    registry.close()

    const reader = openRegistryReader(path)
    try {
      expect(reader.show("wo-legacy")).toMatchObject(expected)
      expect(reader.list()).toHaveLength(1)
    } finally {
      reader.close()
    }
  })
})
