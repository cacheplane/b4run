import type { z } from "zod"
import type { Factory } from "../controller/factory.js"
import { CommandInFlightError, UnknownTaskError, UnknownWorkOrderError } from "../domain/errors.js"
import type { CommandOutcome, WorkOrderRow } from "../domain/work-order.js"
import { StaleRevisionError } from "../registry/work-orders.js"

export type Refusal =
  | "invalid_input"
  | "unknown_task"
  | "unknown_work_order"
  | "command_in_flight"
  | "stale_revision"

/**
 * What every mutating route returns. A workflow route's thrown error is a 500 with no
 * structure, so refusals are values: `ok: false` plus a `refusal` for the cases the old
 * HTTP layer mapped to 400/404/409, and the plain `CommandOutcome` fields otherwise.
 */
export interface RouteOutcome extends CommandOutcome {
  readonly refusal?: Refusal
  readonly issues?: readonly unknown[]
  /** The row after the command, when it exists. */
  readonly row?: WorkOrderRow | null
}

export function refused(
  refusal: Refusal,
  message: string,
  extra: Partial<RouteOutcome> = {},
): RouteOutcome {
  return { ok: false, message, refusal, ...extra }
}

/** Parse, run, and turn the three expected error classes into refusals. */
export async function command<T>(
  schema: z.ZodType<T>,
  input: unknown,
  factory: () => Promise<Factory>,
  run: (parsed: T, factory: Factory) => Promise<RouteOutcome>,
): Promise<RouteOutcome> {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    return refused("invalid_input", "Invalid input", { issues: parsed.error.issues })
  try {
    return await run(parsed.data, await factory())
  } catch (error) {
    if (error instanceof UnknownTaskError) return refused("unknown_task", error.message)
    if (error instanceof UnknownWorkOrderError) return refused("unknown_work_order", error.message)
    if (error instanceof CommandInFlightError) return refused("command_in_flight", error.message)
    // Expected concurrency, not a fault: a background observer or the budget ticker wrote the
    // row between this command's read and its compare-and-swap. The caller re-reads and retries.
    if (error instanceof StaleRevisionError) return refused("stale_revision", error.message)
    throw error
  }
}
