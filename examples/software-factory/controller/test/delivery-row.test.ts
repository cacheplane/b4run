import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import {
  BRANCH_PATTERN,
  RowDeliverySchema,
  type WorkOrderRow,
} from "../src/lib/domain/work-order.ts"
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

const PATH_PREFIXES_REFUSED = ["", "./x", "x/", "/x", "..", "a/../b", "a//b", "a\\b"]
const PATH_PREFIXES_ACCEPTED = [".", "packages/cli"]

describe("a draft-PR delivery's path prefix", () => {
  it("is null or one canonical spelling of a relative path", () => {
    expect(RowDeliverySchema.safeParse(DRAFT_PR).success).toBe(true)
    for (const pathPrefix of PATH_PREFIXES_REFUSED)
      expect(
        RowDeliverySchema.safeParse({ ...DRAFT_PR, pathPrefix }).success,
        JSON.stringify(pathPrefix),
      ).toBe(false)
    for (const pathPrefix of PATH_PREFIXES_ACCEPTED)
      expect(RowDeliverySchema.safeParse({ ...DRAFT_PR, pathPrefix }).success, pathPrefix).toBe(
        true,
      )
  })
})

describe("the branch pattern", () => {
  it("refuses what git check-ref-format refuses", () => {
    for (const branch of ["main", "release/1.x", "factory/wo-0123456789abcdef", "a.b/c"])
      expect(BRANCH_PATTERN.test(branch), branch).toBe(true)
    for (const branch of [
      "/main",
      ".main",
      "a/.b",
      "main.",
      "a/b.",
      "-main",
      "refs/heads/main",
      "a..b",
      "a//b",
      "a/",
      "a.lock",
      "a@{b",
    ])
      expect(BRANCH_PATTERN.test(branch), branch).toBe(false)
  })
})

const at = "2026-10-01T00:00:00.000Z"

function draftRow(delivery: WorkOrderRow["delivery"] = DRAFT_PR): WorkOrderRow {
  return {
    id: "wo-0123456789abcdef",
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    candidateAttempts: 0,
    maxCandidateAttempts: 1,
    maxActiveMs: 60_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: null,
    origin: {
      kind: "issue",
      repository: "cacheplane/b4run",
      number: 912,
      bodyDigest: "0".repeat(64),
    },
    pin: "7".repeat(40),
    targetId: null,
    taskDigest: null,
    intakeAttempts: 0,
    maxIntakeAttempts: 2,
    delivery,
    createdAt: at,
    updatedAt: at,
  }
}

describe("the work-order store and a delivery", () => {
  it("round-trips a draft-PR row delivery and a pull-request receipt", () => {
    const registry = openRegistry(":memory:")
    const store = createWorkOrderStore(registry.db)
    const row = draftRow({ ...DRAFT_PR, pathPrefix: "packages/cli" })
    store.insert(row)
    expect(store.get(row.id)).toEqual(row)
    const delivery = {
      workOrderId: row.id,
      candidateDigest: "c".repeat(64),
      receiptPath: "https://github.com/cacheplane/b4run/pull/7",
      observedAt: at,
      pullRequest: {
        number: 7,
        url: "https://github.com/cacheplane/b4run/pull/7",
        headSha: "1".repeat(40),
        treeSha: "2".repeat(40),
        baseTip: "3".repeat(40),
        aheadBy: 1,
      },
    }
    store.recordDelivery(delivery)
    expect(store.delivery(row.id)).toEqual(delivery)
    registry.close()
  })

  it("fills a draft-PR path prefix once, and changes nothing else about the delivery", () => {
    const registry = openRegistry(":memory:")
    const store = createWorkOrderStore(registry.db)
    store.insert(draftRow())
    const filled = store.update(
      "wo-0123456789abcdef",
      0,
      { delivery: { ...DRAFT_PR, pathPrefix: "packages/cli" } },
      at,
    )
    expect(filled.delivery).toEqual({ ...DRAFT_PR, pathPrefix: "packages/cli" })
    for (const delivery of [
      { ...DRAFT_PR, pathPrefix: "packages/sdk" },
      { ...DRAFT_PR, pathPrefix: null },
      { ...DRAFT_PR, pathPrefix: "packages/cli", baseBranch: "next" },
      { ...DRAFT_PR, pathPrefix: "packages/cli", repository: "cacheplane/other" },
      { ...DRAFT_PR, pathPrefix: "packages/cli", issueStateAtCreate: "closed" as const },
      { kind: "local" as const },
    ])
      expect(
        () => store.update("wo-0123456789abcdef", 1, { delivery }, at),
        JSON.stringify(delivery),
      ).toThrow(/delivery/)
    expect(store.get("wo-0123456789abcdef")?.revision).toBe(1)
    registry.close()
  })

  it("refuses changing a delivery's kind or its fixed fields before the prefix is filled", () => {
    const registry = openRegistry(":memory:")
    const store = createWorkOrderStore(registry.db)
    store.insert(draftRow())
    for (const delivery of [
      { ...DRAFT_PR, branch: "factory/wo-fedcba9876543210" },
      { ...DRAFT_PR, baseBranch: "next", pathPrefix: "." },
      { kind: "local" as const },
    ])
      expect(
        () => store.update("wo-0123456789abcdef", 0, { delivery }, at),
        JSON.stringify(delivery),
      ).toThrow(/delivery/)
    const local = { ...draftRow({ kind: "local" }), id: "wo-local" }
    store.insert(local)
    expect(() =>
      store.update("wo-local", 0, { delivery: { ...DRAFT_PR, pathPrefix: "." } }, at),
    ).toThrow(/delivery/)
    // Restating the same delivery is not a change.
    expect(store.update("wo-local", 0, { delivery: { kind: "local" } }, at).revision).toBe(1)
    registry.close()
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
