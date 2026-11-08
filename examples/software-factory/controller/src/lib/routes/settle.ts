import type { RuntimeContext } from "@b4run/sdk"
import type { Factory } from "../controller/factory.js"
import type { CommandOutcome, WorkOrderRow } from "../domain/work-order.js"
import { type RouteOutcome, refused } from "./outcome.js"

function isCancellation(outcome: Pick<RouteOutcome, "state">): boolean {
  return outcome.state === "cancelled" || outcome.state === "cancel_requested"
}

/**
 * These routes own cancel-aware factory operations. Request Stop through their
 * operation signal. The operation explicitly observes Stop at its settled
 * cancellation boundary; returned values alone never establish that outcome.
 */
export async function withRuntimeStop(
  ctx: Pick<RuntimeContext, "signal" | "stopSignal">,
  operation: (signal: AbortSignal, observeStop: () => void) => Promise<RouteOutcome>,
): Promise<RouteOutcome> {
  ctx.signal.throwIfAborted()
  ctx.stopSignal?.throwIfAborted()
  const signal = ctx.stopSignal ? AbortSignal.any([ctx.signal, ctx.stopSignal]) : ctx.signal
  const outcome = await operation(signal, () => {
    ctx.signal.throwIfAborted()
    ctx.stopSignal?.throwIfAborted()
  })
  // A successful app CommandOutcome still honors hard loss after its cleanup.
  // Independent command failures/refusals and thrown errors retain precedence.
  if (outcome.ok === true) ctx.signal.throwIfAborted()
  return outcome
}

export interface SettleOptions {
  /** Names the run in the "did not settle" message: `Dispatch`, `Intake`, `Redraft`. */
  readonly what: string
  /** The operation key of the cancel an aborted route issues, e.g. `cancel:<id>:aborted-dispatch`. */
  readonly abortKey: string
  /** Is the settled row the outcome a script may treat as success? */
  readonly success: (row: WorkOrderRow) => boolean
  /** The message for a settled row, success or not. */
  readonly message: (row: WorkOrderRow) => string
}

/**
 * Await a run the caller just started (`dispatch`, `intake`, or the redraft a
 * `reject-intake` triggered) and report where it settled. Shared by the awaiting routes so
 * the abort listener, the budget and the "did not settle" shape cannot drift between them.
 *
 * The app-owned signal combines hard abort and an optional soft Stop request.
 * Its listener cancels the work order, and cleanup awaits the cancel it started.
 * It is safe against a late abort by SCHEDULING, not by the command refusing: `cancel`
 * is legal from every non-terminal state, so an abort landing after `settle` resolved would
 * cancel a settled work order — there is no `await` between the settle and the
 * `removeEventListener` below, so the listener is gone before any later abort can be
 * delivered. A competing or stale command key remains a typed refusal: it
 * supplies neither an acknowledgement nor cancellation work this invocation owns.
 */
export async function settleOutcome(
  factory: Factory,
  id: string,
  signal: AbortSignal,
  options: SettleOptions,
  observeStop?: () => void,
): Promise<RouteOutcome> {
  let cancellation: Promise<CommandOutcome> | undefined
  let acknowledgement: "requested" | "confirmed" | undefined
  let preserveFailure = false
  let observedCancellation = false
  const onAbort = () => {
    cancellation ??= factory.cancel(id, options.abortKey, (status) => {
      acknowledgement = status
    })
    // Settlement may still be held when cancellation rejects. Observe it now;
    // cleanup below awaits it and preserves the primary operation failure.
    void cancellation.catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  async function readOutcome(): Promise<RouteOutcome> {
    try {
      // The row's own budget, never a literal: the default lives in `config.ts` and is copied
      // onto the row at create time, so a second copy here would silently disagree with it. No
      // row means no budget to wait on — and nothing to have started either.
      const current = factory.show(id)
      if (!current) {
        preserveFailure = true
        return refused("unknown_work_order", `Unknown work order ${id}`)
      }
      let row: WorkOrderRow
      try {
        row = await factory.settle(id, current.maxActiveMs + 60_000)
      } catch (error) {
        // `settle` throws on timeout and when the factory is aborted mid-wait; both are
        // expected here and a route must not throw. The row is the outcome either way.
        preserveFailure = true
        const stalled = factory.show(id)
        return {
          ok: false,
          ...(stalled ? { state: stalled.state } : {}),
          message: `${options.what} did not settle: ${error instanceof Error ? error.message : String(error)}`,
          row: stalled,
        }
      }
      const outcome = {
        ok: options.success(row),
        state: row.state,
        message: options.message(row),
        row,
      }
      // A controller cancellation acknowledgement may still await remote confirmation.
      observedCancellation = cancellation !== undefined && isCancellation(outcome)
      preserveFailure = !outcome.ok && !observedCancellation
      return outcome
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
  let outcome: RouteOutcome
  try {
    outcome = await readOutcome()
  } catch (error) {
    await cancellation?.catch(() => undefined)
    throw error
  }
  if (preserveFailure) {
    await cancellation?.catch(() => undefined)
    return outcome
  }
  const cancelled = await cancellation
  // The cancel operation explicitly distinguishes accepted requests from
  // refusals/failures; neither row state nor `ok` alone supplies that fact.
  if (cancelled && acknowledgement === undefined) return cancelled
  if (observedCancellation && acknowledgement !== undefined) observeStop?.()
  return outcome
}

/** The intake half of the truth table: only a parked draft is a success. */
export function intakeSettle(id: string, what: "Intake" | "Redraft"): SettleOptions {
  return {
    what,
    abortKey: `cancel:${id}:aborted-intake`,
    // `blocked` (invalid, oracle passed, attempts exhausted, run failed), `cancelled` and
    // `cancel_requested` all owe the operator work.
    success: (row) => row.state === "awaiting_intake_approval",
    message: (row) =>
      row.state === "awaiting_intake_approval"
        ? "Draft awaiting approval"
        : row.state === "cancel_requested"
          ? "Cancel requested; reconciliation will finish it"
          : `${what} settled in ${row.state}${row.blockedReason ? ` (${row.blockedReason})` : ""}`,
  }
}
