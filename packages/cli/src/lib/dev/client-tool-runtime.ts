/**
 * Boot-resolved settings for client-provided tools on the AG-UI endpoint
 * (cacheplane/b4run#743), and the request-size bounds the endpoint enforces
 * for them. Pure and edge-safe: no node: imports.
 */
import type { B4Config } from "@b4run/core"
import type { ClientToolCallStore } from "@b4run/sdk"

/** How long a client tool call waits for its result by default: 10 minutes. */
export const DEFAULT_CLIENT_TOOL_TTL_MS = 600_000
/**
 * Upper bound on `server.agui.clientToolTtlMs`: one year. Keeps `issuedAt +
 * ttl` far inside the range `Date` can represent, and no client tool call
 * legitimately waits longer.
 */
export const MAX_CLIENT_TOOL_TTL_MS = 365 * 24 * 60 * 60 * 1000
/** How long a settled or expired client tool call record is kept by default: 7 days. */
export const DEFAULT_CLIENT_TOOL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The largest client tool result, in UTF-8 bytes of text/JSON, the endpoint
 * will record: a string as is, a part list as its JSON with every inline
 * (`data`) media value blanked. That text becomes prompt content on the
 * resumed turn, so it is bounded like the definitions are; an over-cap result
 * for an outstanding call is refused with `413 client_tool_result_too_large`
 * before it is recorded. Inline media bytes are not counted here: they are
 * bounded by the AG-UI body ceiling (`AGUI_BODY_MAX_BYTES`) and reach the
 * model only where the route model's profile and provider take media in a
 * tool result (spec §6).
 */
export const MAX_CLIENT_TOOL_RESULT = 64 * 1024
export { AGUI_BODY_MAX_BYTES } from "./request-limits.js"

/** What the AG-UI handler needs to issue, match and answer client tool calls. */
export interface ClientToolRuntime {
  /** `undefined` when none resolved: client tool runs are then refused with a 503. */
  readonly store?: ClientToolCallStore
  readonly ttlMs: number
  /** `server.agui.clientToolRetentionMs`, resolved. See {@link clientToolPruneCutoff}. */
  readonly retentionMs: number
}

/** A `server.agui` client-tool setting that cannot be honored as written. */
export class ClientToolConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientToolConfigError"
  }
}

/**
 * `server.agui.clientToolTtlMs`, validated. `B4Config` has no runtime schema,
 * so a value that is present but not a positive integer of at most
 * {@link MAX_CLIENT_TOOL_TTL_MS} fails the boot: replacing it with the default
 * would leave a config that reads as configured while the server ignores it.
 */
export function resolveClientToolTtlMs(value: unknown): number {
  return resolvePositiveMs(
    "server.agui.clientToolTtlMs",
    value,
    DEFAULT_CLIENT_TOOL_TTL_MS,
    (message) => new ClientToolConfigError(message),
  )
}

/**
 * `server.agui.clientToolRetentionMs`, validated the same way as the TTL: a
 * mistyped value fails the boot rather than reading as configured.
 */
export function resolveClientToolRetentionMs(value: unknown): number {
  return resolvePositiveMs(
    "server.agui.clientToolRetentionMs",
    value,
    DEFAULT_CLIENT_TOOL_RETENTION_MS,
    (message) => new ClientToolConfigError(message),
  )
}

/**
 * A positive-integer-milliseconds config setting with a default: `undefined`
 * yields `fallback`; anything else that is not a positive safe integer of at
 * most {@link MAX_CLIENT_TOOL_TTL_MS} (one year) is handed to `fail`, whose
 * error the caller throws so each feature reports its own error class.
 */
export function resolvePositiveMs(
  key: string,
  value: unknown,
  fallback: number,
  fail: (message: string) => Error,
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CLIENT_TOOL_TTL_MS
  ) {
    throw fail(
      `${key} must be a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}; received ${describe(value)}.`,
    )
  }
  return value
}

/**
 * The `before` a prune uses at `now`: `now - max(retentionMs, ttlMs)`. The
 * TTL floor means a record is never deleted while the call it belongs to
 * could still be answered.
 */
export function clientToolPruneCutoff(
  now: Date,
  runtime: Pick<ClientToolRuntime, "ttlMs" | "retentionMs">,
): string {
  return new Date(now.getTime() - Math.max(runtime.retentionMs, runtime.ttlMs)).toISOString()
}

const STORE_METHODS = [
  "issue",
  "get",
  "listForThread",
  "listOutstanding",
  "answer",
  "voidOutstanding",
  "settle",
  "prune",
] as const

/** `server.agui.clientToolStore`, shape-checked: absent, or an object with every store method. */
export function validateClientToolStore(value: unknown): ClientToolCallStore | undefined {
  if (value === undefined) return undefined
  const missing =
    typeof value === "object" && value !== null
      ? STORE_METHODS.filter(
          (method) => typeof (value as Record<string, unknown>)[method] !== "function",
        )
      : [...STORE_METHODS]
  if (missing.length > 0) {
    throw new ClientToolConfigError(
      `server.agui.clientToolStore must be a ClientToolCallStore; missing ${missing.join(", ")}.`,
    )
  }
  return value as ClientToolCallStore
}

/** Whether any route opts in to client tools. */
export function anyRouteOptsInToClientTools(config: B4Config | undefined): boolean {
  const routes = config?.server?.agui?.clientTools
  return Array.isArray(routes) && routes.length > 0
}

function describe(value: unknown): string {
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  return value === null ? "null" : typeof value
}

/** Least time between two opportunistic sweeps of the same store: one hour. */
export const CLIENT_TOOL_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Last sweep per store (ms since epoch). Per process; a WeakMap so a store is never retained by it. */
let lastSweepAt = new WeakMap<ClientToolCallStore, number>()

/** Test seam: forget every store's last sweep time. */
export function __resetClientToolPruneThrottleForTests(): void {
  lastSweepAt = new WeakMap()
}

/**
 * Opportunistic retention for client tool call records, run by the AG-UI
 * handler once a turn has settled (like `voidSettledClientToolCalls` in the
 * AG-UI handler, never allowed to fail the turn). Global, not per thread, so
 * threads that never return are swept too. At most once per
 * {@link CLIENT_TOOL_PRUNE_INTERVAL_MS} per store; a call inside the interval
 * returns `undefined` without touching the store. The sweep time is recorded
 * before the call, so a failed sweep is not retried until the interval elapses
 * either, which bounds the warning to once an hour per store. Never throws: a
 * store failure is warned about and the turn is unaffected.
 *
 * Returns the number of rows deleted, or `undefined` when nothing ran.
 */
export async function pruneClientToolCalls(
  store: ClientToolCallStore,
  runtime: Pick<ClientToolRuntime, "ttlMs" | "retentionMs">,
  now: Date,
): Promise<number | undefined> {
  const last = lastSweepAt.get(store)
  if (last !== undefined && now.getTime() - last < CLIENT_TOOL_PRUNE_INTERVAL_MS) return undefined
  lastSweepAt.set(store, now.getTime())
  try {
    return await store.prune({ before: clientToolPruneCutoff(now, runtime) })
  } catch (error) {
    console.warn("B4: could not prune client tool calls.", error)
    return undefined
  }
}
