import type { DatabaseSync } from "node:sqlite"
import {
  type Approval,
  ApprovalSchema,
  type Delivery,
  DeliverySchema,
  type FactoryEvent,
  FactoryEventSchema,
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

/** Fields a command may change. Identity, limits and timestamps are fixed at insert. */
export type WorkOrderPatch = Partial<
  Pick<
    WorkOrderRow,
    | "state"
    | "workerThreadId"
    | "interruptId"
    | "candidateDigest"
    | "candidateVerified"
    | "blockedReason"
    | "failureReason"
    | "activeMs"
    | "activeStartedAt"
    | "awaitingSince"
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
   * Run `fn` inside a transaction. Reentrant: only the outermost call issues
   * BEGIN/COMMIT/ROLLBACK, so a nested call joins the enclosing transaction and a
   * throw anywhere inside rolls the whole thing back.
   */
  transaction<T>(fn: () => T): T
}

const COLUMNS: Readonly<Record<keyof WorkOrderRow, string>> = {
  id: "id",
  revision: "revision",
  state: "state",
  taskId: "task_id",
  workerRoute: "worker_route",
  workerThreadId: "worker_thread_id",
  interruptId: "interrupt_id",
  candidateDigest: "candidate_digest",
  candidateVerified: "candidate_verified",
  blockedReason: "blocked_reason",
  failureReason: "failure_reason",
  maxCandidateAttempts: "max_candidate_attempts",
  maxActiveMs: "max_active_ms",
  activeMs: "active_ms",
  activeStartedAt: "active_started_at",
  awaitingSince: "awaiting_since",
  createdAt: "created_at",
  updatedAt: "updated_at",
}

type SqlValue = string | number | null

function toSql(key: keyof WorkOrderRow, value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" || typeof value === "string") return value
  throw new TypeError(`Unsupported value for ${key}`)
}

function fromSql(record: Record<string, unknown>): WorkOrderRow {
  const raw: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(COLUMNS) as [keyof WorkOrderRow, string][]) {
    const value = record[column]
    raw[key] =
      key === "candidateVerified" && value !== null && value !== undefined
        ? value === 1
        : (value ?? null)
  }
  return WorkOrderRowSchema.parse(raw)
}

export function createWorkOrderStore(db: DatabaseSync): WorkOrderStore {
  /** Open transaction depth: only depth 0 -> 1 issues BEGIN, and only it commits. */
  let depth = 0
  const keys = Object.keys(COLUMNS) as (keyof WorkOrderRow)[]
  const insertSql = `INSERT INTO work_orders (${keys.map((k) => COLUMNS[k]).join(", ")}) VALUES (${keys
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
      db.prepare(insertSql).run(...keys.map((k) => toSql(k, row[k])))
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
        "INSERT INTO approvals (id, work_order_id, interrupt_id, candidate_digest, decision, decided_by, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        approval.id,
        approval.workOrderId,
        approval.interruptId,
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
          interruptId: r.interrupt_id,
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
      if (depth > 0) {
        depth += 1
        try {
          return fn()
        } finally {
          depth -= 1
        }
      }
      db.exec("BEGIN")
      depth = 1
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      } finally {
        depth = 0
      }
    },
  }
}
