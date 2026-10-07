/**
 * The open/closed rule of every activity disclosure (spec §3.1) as a pure
 * reducer, so the React hook and the Angular signal wrapper are one rule:
 * automation decides until the user toggles, and the user's choice holds
 * until the item becomes live again — where "again" means a *different*
 * presentation of it. With a `resetKey` (a step's `startedAt`) a call that
 * goes awaiting → running under the same key never closes what the user
 * opened; the choice is cleared only when the item is live under a key it has
 * not been live under before. Without a key, every rise of `live` clears it.
 */
export interface DisclosureMemory {
  /** The user's choice, or undefined while automation decides. */
  readonly manual: boolean | undefined
  readonly wasLive: boolean
  readonly lastKey: unknown
}

/** The memory of a disclosure first seen with this `live` and `resetKey`. */
export function initialDisclosure(live: boolean, resetKey?: unknown): DisclosureMemory {
  return { manual: undefined, wasLive: live, lastKey: resetKey }
}

/**
 * The memory after observing `live` and `resetKey` again. Returns `memory`
 * itself when nothing changed, so callers can skip an update.
 */
export function observeDisclosure(
  memory: DisclosureMemory,
  live: boolean,
  resetKey?: unknown,
): DisclosureMemory {
  const rose = live && !memory.wasLive
  if (!live) return memory.wasLive ? { ...memory, wasLive: false } : memory
  const changed = resetKey === undefined ? rose : resetKey !== memory.lastKey
  if (changed) return { manual: undefined, wasLive: true, lastKey: resetKey }
  return memory.wasLive ? memory : { ...memory, wasLive: true }
}

/** Whether the disclosure is open: the user's choice, else automation's `autoOpen`. */
export function isDisclosureOpen(memory: DisclosureMemory, autoOpen: boolean): boolean {
  return memory.manual ?? autoOpen
}

/** The memory after the user toggles a disclosure that automation would hold at `autoOpen`. */
export function toggleDisclosure(memory: DisclosureMemory, autoOpen: boolean): DisclosureMemory {
  return { ...memory, manual: !isDisclosureOpen(memory, autoOpen) }
}
