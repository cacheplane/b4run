import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { RowDeliverySchema } from "../src/lib/domain/work-order.ts"
import { MIGRATIONS, openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

const DRAFT_PR = {
  kind: "draft-pr" as const,
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pathPrefix: null,
  issueStateAtCreate: "open" as const,
}

describe("a work order's delivery", () => {
  it("accepts only factory/<work order id> as the branch", () => {
    const draft = DRAFT_PR
    expect(RowDeliverySchema.parse(draft)).toEqual(draft)
    for (const branch of [
      "main",
      "factory/x",
      "factory/wo-0123456789abcdef/y",
      "refs/heads/factory/wo-0123456789abcdef",
    ])
      expect(RowDeliverySchema.safeParse({ ...draft, branch }).success).toBe(false)
  })
})

describe("registry migration 6", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("reads every existing work order as a local export and adds the outbox", () => {
    dir = mkdtempSync(join(tmpdir(), "migration-6-"))
    const path = join(dir, "registry.sqlite")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
    for (const migration of MIGRATIONS.slice(0, 5)) {
      db.exec(migration.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(migration.version)
    }
    const at = "2026-10-01T00:00:00.000Z"
    db.prepare(
      `INSERT INTO work_orders (id, revision, state, task_id, worker_route, max_candidate_attempts,
         max_active_ms, active_ms, created_at, updated_at)
       VALUES ('wo-legacy', 0, 'exported', 'cli-flags', '/build#agent', 1, 60000, 0, ?, ?)`,
    ).run(at, at)
    db.prepare(
      "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at) VALUES ('wo-legacy', ?, '/x.json', ?)",
    ).run("c".repeat(64), at)
    db.close()
    const registry = openRegistry(path)
    const store = createWorkOrderStore(registry.db)
    expect(store.get("wo-legacy")?.delivery).toEqual({ kind: "local" })
    expect(store.delivery("wo-legacy")).toEqual({
      workOrderId: "wo-legacy",
      candidateDigest: "c".repeat(64),
      receiptPath: "/x.json",
      observedAt: at,
    })
    const tables = (
      registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((t) => t.name)
    expect(tables).toContain("delivery_outbox")
    registry.close()
  })
})
