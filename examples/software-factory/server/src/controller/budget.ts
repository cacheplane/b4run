import { ACTIVE_STATES } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { WorkOrderStore } from "../registry/work-orders.js"

export interface BudgetTicker {
  stop(): void
}

/** Active time so far: banked `activeMs` plus the open interval, if any. */
export function activeElapsedMs(row: WorkOrderRow, nowMs: number): number {
  const open = row.activeStartedAt ? Math.max(0, nowMs - Date.parse(row.activeStartedAt)) : 0
  return row.activeMs + open
}

export function startBudgetTicker(options: {
  readonly store: WorkOrderStore
  readonly now: () => number
  readonly tickMs: number
  readonly onExhausted: (id: string) => Promise<void>
}): BudgetTicker {
  const firing = new Set<string>()
  const timer = setInterval(() => {
    const nowMs = options.now()
    for (const row of options.store.list()) {
      if (!ACTIVE_STATES.has(row.state) || firing.has(row.id)) continue
      if (activeElapsedMs(row, nowMs) <= row.maxActiveMs) continue
      firing.add(row.id)
      void options.onExhausted(row.id).finally(() => firing.delete(row.id))
    }
  }, options.tickMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
