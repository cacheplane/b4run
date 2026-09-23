import type { DatabaseSync } from "node:sqlite"
import {
  type Approval,
  ApprovalSchema,
  type Delivery,
  DeliverySchema,
  type FactoryEvent,
  FactoryEventSchema,
  type Origin,
  OriginSchema,
  type WorkOrderRow,
  WorkOrderRowSchema,
} from "../domain/work-order.js"

export class StaleRevisionError extends Error {
  constructor(
    readonly id: string,
    readonly expectedRevision: number,
  ) {
    super(`Work order ${id} is not at revision ${expectedRevision}`)
    this.name = "StaleRevisionError"
  }
}

/**
 * Fields a command may change. Identity, limits, origin, pin and timestamps are fixed at
 * insert: `origin` and `pin` are what the work order is, not where it got to, and
 * `maxIntakeAttempts` is the cap set at create.
 */
export type WorkOrderPatch = Partial<
  Pick<
    WorkOrderRow,
    | "state"
    | "workerThreadId"
    | "interruptId"
    | "candidateDigest"
    | "bundleDigest"
    | "blockedReason"
    | "failureReason"
    | "activeMs"
    | "activeStartedAt"
    | "awaitingSince"
    | "targetId"
    | "taskDigest"
    | "intakeAttempts"
  >
>

export interface WorkOrderStore {
  insert(row: WorkOrderRow): void
  get(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  /** Compare-and-swap: applies `patch` only if the row is at `expectedRevision`; increments it. */
  update(id: string, expectedRevision: number, patch: WorkOrderPatch, now: string): WorkOrderRow
  appendEvent(
    workOrderId: string,
    type: string,
    payload: Record<string, unknown>,
    now: string,
  ): void
  events(workOrderId: string): FactoryEvent[]
  recordApproval(approval: Approval): void
  approvals(workOrderId: string): Approval[]
  recordDelivery(delivery: Delivery): void
  delivery(workOrderId: string): Delivery | null
  /**
   * Run `fn` inside a transaction. Reentrant, and the nesting depth is tracked per database
   * connection, so two stores over one `DatabaseSync` share it. The outermost call issues
   * BEGIN/COMMIT/ROLLBACK; a nested call issues `SAVEPOINT sp<depth>` and releases it on
   * success, and on a throw issues `ROLLBACK TO sp<depth>` then `RELEASE sp<depth>` and
   * rethrows. So an inner throw the caller catches discards only the inner writes, while a
   * throw that escapes the outermost call rolls the whole thing back.
   */
  transaction<T>(fn: () => T): T
}

/**
 * The scalar columns. `origin` is an object and is split over ORIGIN_COLUMNS instead, so it
 * is the one row field with no entry here.
 */
const COLUMNS: Readonly<Record<Exclude<keyof WorkOrderRow, "origin">, string>> = {
  id: "id",
  revision: "revision",
  state: "state",
  taskId: "task_id",
  workerRoute: "worker_route",
  workerThreadId: "worker_thread_id",
  interruptId: "interrupt_id",
  candidateDigest: "candidate_digest",
  bundleDigest: "bundle_digest",
  blockedReason: "blocked_reason",
  failureReason: "failure_reason",
  maxCandidateAttempts: "max_candidate_attempts",
  maxActiveMs: "max_active_ms",
  activeMs: "active_ms",
  activeStartedAt: "active_started_at",
  awaitingSince: "awaiting_since",
  pin: "pin",
  targetId: "target_id",
  taskDigest: "task_digest",
  intakeAttempts: "intake_attempts",
  maxIntakeAttempts: "max_intake_attempts",
  createdAt: "created_at",
  updatedAt: "updated_at",
}

const ORIGIN_COLUMNS = [
  "origin_kind",
  "origin_repository",
  "origin_number",
  "origin_body_digest",
] as const

type SqlValue = string | number | null

function originToSql(origin: Origin): [string, string | null, number | null, string | null] {
  return origin.kind === "catalog"
    ? ["catalog", null, null, null]
    : ["issue", origin.repository, origin.number, origin.bodyDigest]
}

function originFromSql(record: Record<string, unknown>): Origin {
  const kind = record.origin_kind
  if (kind === "catalog") return { kind: "catalog" }
  // Anything else is a corrupt row, not a catalog one: a default here would read it as fine.
  if (kind !== "issue") throw new Error(`Unknown origin_kind ${String(kind)}`)
  return OriginSchema.parse({
    kind: "issue",
    repository: record.origin_repository,
    number: record.origin_number,
    bodyDigest: record.origin_body_digest,
  })
}

function toSql(key: keyof typeof COLUMNS, value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === "number" || typeof value === "string") return value
  throw new TypeError(`Unsupported value for ${key}`)
}

function fromSql(record: Record<string, unknown>): WorkOrderRow {
  const raw: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    raw[key] = record[column] ?? null
  }
  raw.origin = originFromSql(record)
  return WorkOrderRowSchema.parse(raw)
}

/**
 * Open transaction depth per connection, not per store: nesting is a property of the
 * `DatabaseSync` handle, so two stores over one connection must agree on who owns the
 * outermost BEGIN. Keyed weakly so a closed database can still be collected.
 */
const DEPTHS = new WeakMap<DatabaseSync, { depth: number }>()

const depthOf = (db: DatabaseSync): { depth: number } => {
  const existing = DEPTHS.get(db)
  if (existing) return existing
  const fresh = { depth: 0 }
  DEPTHS.set(db, fresh)
  return fresh
}

export function createWorkOrderStore(db: DatabaseSync): WorkOrderStore {
  const open = depthOf(db)
  const keys = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]
  const columns = [...keys.map((k) => COLUMNS[k]), ...ORIGIN_COLUMNS]
  const insertSql = `INSERT INTO work_orders (${columns.join(", ")}) VALUES (${columns
    .map(() => "?")
    .join(", ")})`

  const get = (id: string): WorkOrderRow | null => {
    const record = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined
    return record ? fromSql(record) : null
  }

  return {
    insert(row) {
      WorkOrderRowSchema.parse(row)
      db.prepare(insertSql).run(...keys.map((k) => toSql(k, row[k])), ...originToSql(row.origin))
    },
    get,
    list() {
      const records = db
        .prepare("SELECT * FROM work_orders ORDER BY created_at, id")
        .all() as Record<string, unknown>[]
      return records.map(fromSql)
    },
    update(id, expectedRevision, patch, now) {
      const entries = Object.entries(patch) as [keyof WorkOrderPatch, unknown][]
      const assignments = entries.map(([key]) => `${COLUMNS[key]} = ?`)
      assignments.push("revision = revision + 1", "updated_at = ?")
      const result = db
        .prepare(`UPDATE work_orders SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
        .run(...entries.map(([key, value]) => toSql(key, value)), now, id, expectedRevision)
      if (result.changes !== 1) throw new StaleRevisionError(id, expectedRevision)
      const row = get(id)
      if (!row) throw new Error(`Work order ${id} vanished during update`)
      return row
    },
    appendEvent(workOrderId, type, payload, now) {
      db.prepare("INSERT INTO events (work_order_id, type, payload, at) VALUES (?, ?, ?, ?)").run(
        workOrderId,
        type,
        JSON.stringify(payload),
        now,
      )
    },
    events(workOrderId) {
      const records = db
        .prepare(
          "SELECT seq, work_order_id, type, payload, at FROM events WHERE work_order_id = ? ORDER BY seq",
        )
        .all(workOrderId) as {
        seq: number
        work_order_id: string
        type: string
        payload: string
        at: string
      }[]
      return records.map((r) =>
        FactoryEventSchema.parse({
          seq: r.seq,
          workOrderId: r.work_order_id,
          type: r.type,
          payload: JSON.parse(r.payload),
          at: r.at,
        }),
      )
    },
    recordApproval(approval) {
      ApprovalSchema.parse(approval)
      db.prepare(
        "INSERT INTO approvals (id, work_order_id, bundle_digest, candidate_digest, decision, decided_by, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        approval.id,
        approval.workOrderId,
        approval.bundleDigest,
        approval.candidateDigest,
        approval.decision,
        approval.decidedBy,
        approval.decidedAt,
        approval.expiresAt,
      )
    },
    approvals(workOrderId) {
      const records = db
        .prepare("SELECT * FROM approvals WHERE work_order_id = ? ORDER BY decided_at, id")
        .all(workOrderId) as Record<string, string>[]
      return records.map((r) =>
        ApprovalSchema.parse({
          id: r.id,
          workOrderId: r.work_order_id,
          bundleDigest: r.bundle_digest,
          candidateDigest: r.candidate_digest,
          decision: r.decision,
          decidedBy: r.decided_by,
          decidedAt: r.decided_at,
          expiresAt: r.expires_at,
        }),
      )
    },
    recordDelivery(delivery) {
      DeliverySchema.parse(delivery)
      db.prepare(
        "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at) VALUES (?, ?, ?, ?)",
      ).run(
        delivery.workOrderId,
        delivery.candidateDigest,
        delivery.receiptPath,
        delivery.observedAt,
      )
    },
    delivery(workOrderId) {
      const r = db.prepare("SELECT * FROM deliveries WHERE work_order_id = ?").get(workOrderId) as
        | Record<string, string>
        | undefined
      return r
        ? DeliverySchema.parse({
            workOrderId: r.work_order_id,
            candidateDigest: r.candidate_digest,
            receiptPath: r.receipt_path,
            observedAt: r.observed_at,
          })
        : null
    },
    transaction(fn) {
      if (open.depth > 0) {
        const name = `sp${open.depth}`
        db.exec(`SAVEPOINT ${name}`)
        open.depth += 1
        try {
          const result = fn()
          db.exec(`RELEASE ${name}`)
          return result
        } catch (error) {
          db.exec(`ROLLBACK TO ${name}`)
          db.exec(`RELEASE ${name}`)
          throw error
        } finally {
          open.depth -= 1
        }
      }
      db.exec("BEGIN")
      open.depth = 1
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      } finally {
        open.depth = 0
      }
    },
  }
}
