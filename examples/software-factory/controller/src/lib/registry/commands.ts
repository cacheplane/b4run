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
  /**
   * Record the intent under `operationKey`, or report what is already recorded.
   * Throws if `operationKey` was already used with a different intent or for another work
   * order: a key names one command on one work order, and replaying another's outcome under it
   * would answer a question nobody asked.
   */
  begin(operationKey: string, workOrderId: string, intent: CommandIntent, now: string): BeginResult
  /**
   * The recorded outcome under `operationKey`, or null when the key is unused or still in
   * flight. Read-only: for a command whose pre-key refusals must not shadow a spent key's
   * replay. Throws, as `begin` does, when the key was spent on another intent or work order.
   */
  outcome(operationKey: string, workOrderId: string, intent: CommandIntent): CommandOutcome | null
  /** Record the outcome. Throws if the key is unknown or already has an outcome. */
  complete(operationKey: string, outcome: CommandOutcome): void
  /** Intents committed without an outcome, oldest first (ties broken by insertion order). */
  open(): OpenCommand[]
}

/**
 * `DatabaseSync` is synchronous and single-process, so the SELECT-then-INSERT in `begin`
 * cannot race with a concurrent writer between the two statements.
 */
export function createCommandLog(db: DatabaseSync): CommandLog {
  /** What is recorded under the key, refused when it names another intent or work order. */
  const recorded = (
    operationKey: string,
    workOrderId: string,
    intent: CommandIntent,
  ): { intent: CommandIntent; outcome: string | null } | undefined => {
    const existing = db
      .prepare("SELECT work_order_id, intent, outcome FROM commands WHERE operation_key = ?")
      .get(operationKey) as
      | { work_order_id: string; intent: string; outcome: string | null }
      | undefined
    if (!existing) return undefined
    const recordedIntent = CommandIntentSchema.parse(JSON.parse(existing.intent))
    if (JSON.stringify(recordedIntent) !== JSON.stringify(intent))
      throw new Error(`Operation key ${operationKey} was already used with a different intent`)
    if (existing.work_order_id !== workOrderId)
      throw new Error(
        `Operation key ${operationKey} was already used for work order ${existing.work_order_id}`,
      )
    return { intent: recordedIntent, outcome: existing.outcome }
  }
  return {
    begin(operationKey, workOrderId, intent, now) {
      CommandIntentSchema.parse(intent)
      const existing = recorded(operationKey, workOrderId, intent)
      if (existing) {
        const recordedIntent = existing.intent
        if (existing.outcome !== null)
          return {
            status: "done",
            outcome: CommandOutcomeSchema.parse(JSON.parse(existing.outcome)),
          }
        return {
          status: "in_flight",
          intent: recordedIntent,
        }
      }
      db.prepare(
        "INSERT INTO commands (operation_key, work_order_id, command, intent, outcome, at) VALUES (?, ?, ?, ?, NULL, ?)",
      ).run(operationKey, workOrderId, intent.command, JSON.stringify(intent), now)
      return { status: "new" }
    },
    outcome(operationKey, workOrderId, intent) {
      const existing = recorded(operationKey, workOrderId, intent)
      if (existing?.outcome == null) return null
      return CommandOutcomeSchema.parse(JSON.parse(existing.outcome))
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
          "SELECT operation_key, work_order_id, intent FROM commands WHERE outcome IS NULL ORDER BY at, rowid",
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
