/**
 * Boot-resolved settings for client-provided tools on the AG-UI endpoint
 * (cacheplane/b4run#743), and the request-size bounds the endpoint enforces
 * for them, plus the tool-call record retention window
 * (`server.agui.toolCallRetentionMs`). Pure and edge-safe: no node: imports.
 */
import type { B4Config } from "@b4run/core"
import type { ClientToolCallStore } from "@b4run/sdk"

/** How long a client tool call waits for its result by default: 10 minutes. */
export const DEFAULT_CLIENT_TOOL_TTL_MS = 600_000
/** How long a closed tool-call row is kept before the per-thread prune deletes it: 7 days. */
export const DEFAULT_TOOL_CALL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Upper bound on `server.agui.toolCallRetentionMs`: one year. */
export const MAX_TOOL_CALL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
/**
 * Upper bound on `server.agui.clientToolTtlMs`: one year. Keeps `issuedAt +
 * ttl` far inside the range `Date` can represent, and no client tool call
 * legitimately waits longer.
 */
export const MAX_CLIENT_TOOL_TTL_MS = 365 * 24 * 60 * 60 * 1000
/**
 * The largest client tool result, in UTF-8 bytes, the endpoint will record.
 * Every byte of it becomes prompt content on the resumed turn, so it is
 * bounded like the definitions are; an over-cap result for an outstanding
 * call is refused with `413 client_tool_result_too_large` before it is
 * recorded.
 */
export const MAX_CLIENT_TOOL_RESULT = 64 * 1024
/**
 * The `POST /agui/:routeId` body ceiling. Larger than the other JSON
 * endpoints' 1 MiB because every AG-UI client resends the thread's entire
 * message history on every run; 8 MiB leaves room for a long conversation
 * while keeping one request from buffering without bound.
 */
export const AGUI_BODY_MAX_BYTES = 8 * 1024 * 1024

/** What the AG-UI handler needs to issue, match and answer client tool calls. */
export interface ClientToolRuntime {
  /** `undefined` when none resolved: client tool runs are then refused with a 503. */
  readonly store?: ClientToolCallStore
  readonly ttlMs: number
  /** Closed rows older than this are pruned on the thread's next run. */
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
  if (value === undefined) return DEFAULT_CLIENT_TOOL_TTL_MS
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CLIENT_TOOL_TTL_MS
  ) {
    throw new ClientToolConfigError(
      `server.agui.clientToolTtlMs must be a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}; received ${describe(value)}.`,
    )
  }
  return value
}

/** `server.agui.toolCallRetentionMs`, validated exactly like the TTL. */
export function resolveToolCallRetentionMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TOOL_CALL_RETENTION_MS
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TOOL_CALL_RETENTION_MS
  ) {
    throw new ClientToolConfigError(
      `server.agui.toolCallRetentionMs must be a positive integer number of milliseconds no greater than ${MAX_TOOL_CALL_RETENTION_MS}; received ${describe(value)}.`,
    )
  }
  return value
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
