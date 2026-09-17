/**
 * Operator-facing error reporting for the runtime's stderr lines.
 *
 * Every store failure on an edge or Vercel deploy reaches the same catch-all,
 * and not every one of them is an `Error`. `@neondatabase/serverless` rejects a
 * failed WebSocket connect with the socket's `ErrorEvent`: the message, the
 * driver's code and the underlying `Error` (ECONNREFUSED, ENOTFOUND, a TLS
 * failure) all live on properties — `message`, `error` — that `String(event)`
 * never reads. What reached the log was `[object ErrorEvent]`, and the only way
 * to learn which host refused was to reproduce locally (#689).
 *
 * `serializeError` reads those properties off anything thrown — an `Error`, an
 * `ErrorEvent`, a plain object, a primitive — and follows the nested chain
 * (`cause` first, the DOM `error` property second) so a wrapped failure names
 * its root. `formatErrorChain` renders that as one log line per link.
 *
 * Edge-safe on purpose: no `node:` import, nothing that needs a `process`
 * global, so the generated `stores.mjs` can use it through `@b4run/cli/fetch`.
 */

export interface SerializedError {
  /** The constructor or `name`, omitted for a plain `Error` or plain object. */
  readonly name?: string
  readonly message: string
  /** A string or numeric `code` property, as the drivers set them. */
  readonly code?: string
  readonly cause?: SerializedError
}

/** How many links of a cause chain are followed before the report truncates. */
const MAX_CAUSE_DEPTH = 8

function readOwnOrInherited(value: object, key: string): unknown {
  return key in value ? (value as Record<string, unknown>)[key] : undefined
}

function readCode(value: object): string | undefined {
  const code = readOwnOrInherited(value, "code")
  if (typeof code === "string" && code.length > 0) return code
  if (typeof code === "number" && Number.isFinite(code)) return String(code)
  return undefined
}

function readName(value: object): string | undefined {
  const own = readOwnOrInherited(value, "name")
  const name =
    typeof own === "string" && own.length > 0
      ? own
      : typeof value.constructor === "function" && value.constructor.name.length > 0
        ? value.constructor.name
        : undefined
  // A plain `Error` or a plain object carries no information in its name.
  if (name === undefined || name === "Error" || name === "Object") return undefined
  return name
}

/**
 * The nested failure, if any. `cause` is the ECMAScript convention and wins;
 * `error` is where an `ErrorEvent` keeps the `Error` the socket raised. Only an
 * object counts — a string `error` field is a message, not a chain link.
 */
function readNested(value: object): unknown {
  const cause = readOwnOrInherited(value, "cause")
  if (cause !== undefined && cause !== null) return cause
  const inner = readOwnOrInherited(value, "error")
  if (inner !== null && (typeof inner === "object" || typeof inner === "function")) return inner
  return undefined
}

function serialize(error: unknown, seen: Set<object>, depth: number): SerializedError {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return { message: String(error) }
  }
  if (seen.has(error)) return { message: "[circular cause]" }
  if (depth >= MAX_CAUSE_DEPTH) return { message: "[cause chain truncated]" }
  seen.add(error)

  const name = readName(error)
  const rawMessage = readOwnOrInherited(error, "message")
  const nested = readNested(error)
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : `${name ?? "error"} without a message`
  const code = readCode(error)

  return {
    ...(name !== undefined ? { name } : {}),
    message,
    ...(code !== undefined ? { code } : {}),
    ...(nested !== undefined ? { cause: serialize(nested, seen, depth + 1) } : {}),
  }
}

/**
 * Read the message, code and nested cause chain off anything that was thrown.
 * Never throws itself, and never returns `[object ...]` for a thrown object.
 */
export function serializeError(error: unknown): SerializedError {
  return serialize(error, new Set(), 0)
}

function describeLink(link: SerializedError): string {
  const prefix = link.name ? `${link.name}: ` : ""
  const suffix = link.code ? ` (${link.code})` : ""
  return `${prefix}${link.message}${suffix}`
}

/**
 * One line for the failure, then one indented `caused by:` line per link of
 * the chain, so the operator sees the root — the refused host, the DNS
 * failure — under the wrapper that surfaced it.
 */
export function formatErrorChain(error: unknown): string {
  const serialized = serializeError(error)
  const lines = [describeLink(serialized)]
  for (let link = serialized.cause; link; link = link.cause) {
    lines.push(`caused by: ${describeLink(link)}`)
  }
  return lines.join("\n  ")
}

/**
 * The first stack trace anywhere in the chain. An `ErrorEvent` has none of its
 * own; the `Error` it wraps does, and that is the one worth printing.
 */
export function errorStackOf(error: unknown): string | undefined {
  const seen = new Set<object>()
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== "object" || seen.has(current)) return undefined
    seen.add(current)
    const stack = readOwnOrInherited(current, "stack")
    if (typeof stack === "string" && stack.length > 0) return stack
    current = readNested(current)
  }
  return undefined
}

/**
 * The part of a connection string that is safe to log: scheme, host, port and
 * database. The user, the password and every query parameter (which is where
 * `?password=` and `?sslrootcert=` travel) are dropped, and a string the URL
 * parser rejects — a libpq `host=… password=…` keyword string, a typo — is not
 * echoed at all, because its unparsed form is exactly where a credential would
 * be.
 */
export function describeConnectionTarget(connectionString: string): string {
  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    return "an unparseable connection string (redacted)"
  }
  const scheme = parsed.protocol.replace(/:$/, "")
  const host = parsed.hostname.length > 0 ? parsed.hostname : "<no host>"
  const port = parsed.port.length > 0 ? `:${parsed.port}` : ""
  const database = parsed.pathname.replace(/^\/+/, "")
  return `${scheme}://${host}${port}${database.length > 0 ? `/${database}` : ""}`
}
