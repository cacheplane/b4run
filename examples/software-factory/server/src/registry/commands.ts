import type { DatabaseSync } from "node:sqlite"
import {
  type CommandIntent,
  CommandIntentSchema,
  type CommandOutcome,
  CommandOutcomeSchema,
} from "../domain/work-order.js"

export type BeginResult =
  | { readonly status: "new" }
  | { readonly status: "in_flight"; readonly intent: CommandIntent }
  | { readonly status: "done"; readonly outcome: CommandOutcome }

export interface OpenCommand {
  readonly operationKey: string
  readonly workOrderId: string
  readonly intent: CommandIntent
}

export interface CommandLog {
  /** Record the intent under `operationKey`, or report what is already recorded. */
  begin(operationKey: string, workOrderId: string, intent: CommandIntent, now: string): BeginResult
  /** Record the outcome. Throws if the key is unknown or already has an outcome. */
  complete(operationKey: string, outcome: CommandOutcome): void
  /** Intents committed without an outcome, oldest first. */
  open(): OpenCommand[]
}

export function createCommandLog(db: DatabaseSync): CommandLog {
  return {
    begin(operationKey, workOrderId, intent, now) {
      CommandIntentSchema.parse(intent)
      const existing = db
        .prepare("SELECT intent, outcome FROM commands WHERE operation_key = ?")
        .get(operationKey) as { intent: string; outcome: string | null } | undefined
      if (existing) {
        if (existing.outcome !== null)
          return {
            status: "done",
            outcome: CommandOutcomeSchema.parse(JSON.parse(existing.outcome)),
          }
        return {
          status: "in_flight",
          intent: CommandIntentSchema.parse(JSON.parse(existing.intent)),
        }
      }
      db.prepare(
        "INSERT INTO commands (operation_key, work_order_id, command, intent, outcome, at) VALUES (?, ?, ?, ?, NULL, ?)",
      ).run(operationKey, workOrderId, intent.command, JSON.stringify(intent), now)
      return { status: "new" }
    },
    complete(operationKey, outcome) {
      CommandOutcomeSchema.parse(outcome)
      const result = db
        .prepare("UPDATE commands SET outcome = ? WHERE operation_key = ? AND outcome IS NULL")
        .run(JSON.stringify(outcome), operationKey)
      if (result.changes !== 1)
        throw new Error(`Command ${operationKey} is unknown or already completed`)
    },
    open() {
      const rows = db
        .prepare(
          "SELECT operation_key, work_order_id, intent FROM commands WHERE outcome IS NULL ORDER BY at, operation_key",
        )
        .all() as { operation_key: string; work_order_id: string; intent: string }[]
      return rows.map((r) => ({
        operationKey: r.operation_key,
        workOrderId: r.work_order_id,
        intent: CommandIntentSchema.parse(JSON.parse(r.intent)),
      }))
    },
  }
}
