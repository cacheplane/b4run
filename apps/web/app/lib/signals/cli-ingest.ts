/**
 * Ingest for the `b4` CLI's anonymous usage signals. The request contract and
 * the rules below are documented in `docs/growth/README.md`, "CLI signals".
 *
 * The route validates every request, drops anything outside the allowlist, and
 * forwards accepted events to PostHog server-side without the caller's IP and
 * without a person profile. Forwarding is off unless
 * `GROWTH_CLI_SIGNALS_ENABLED=true` and a project key are both set, so the
 * route can deploy dark. Responses never echo the request.
 */

export const CLI_INGEST_MAX_BODY_BYTES = 16_384
export const CLI_INGEST_MAX_EVENTS = 10
export const CLI_INGEST_MAX_STRING_LENGTH = 128

const FORWARD_TIMEOUT_MS = 3_000
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PropertyRule =
  | { readonly type: "string"; readonly required: boolean; readonly values?: readonly string[] }
  | { readonly type: "integer"; readonly required: boolean }

const requiredString = { type: "string", required: true } as const

/** The only events and properties the route accepts. Pinned to the CLI by `cli-ingest-contract.test.ts`. */
export const CLI_SIGNAL_RULES = {
  "cli:command_completed": {
    command: {
      type: "string",
      required: true,
      values: ["dev", "build", "add", "check", "typegen", "verify", "eval"],
    },
    cli_version: requiredString,
    node_major: { type: "integer", required: true },
    os: requiredString,
    outcome: { type: "string", required: true, values: ["ok", "error", "cancelled"] },
    duration_bucket: {
      type: "string",
      required: true,
      values: ["under_1s", "1s_to_10s", "10s_to_1m", "1m_to_10m", "over_10m"],
    },
    error_class: { type: "string", required: false },
  },
  "cli:dev_first_run_completed": {
    cli_version: requiredString,
    route_kind: { type: "string", required: true, values: ["agent", "chain", "graph", "workflow"] },
  },
} as const satisfies Record<string, Record<string, PropertyRule>>

export type CliSignalEventName = keyof typeof CLI_SIGNAL_RULES

interface AcceptedEvent {
  readonly event: CliSignalEventName
  readonly properties: Readonly<Record<string, string | number>>
}

type ParseResult =
  | { readonly ok: true; readonly usageId: string; readonly events: readonly AcceptedEvent[] }
  | { readonly ok: false }

type Env = Readonly<Record<string, string | undefined>>

export interface CliSignalsHandlerOptions {
  /** Runs the PostHog forward after the response is sent (`after` from `next/server` in the route). */
  readonly schedule: (task: () => Promise<void>) => void
  readonly env?: () => Env
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly now?: () => Date
}

export function createCliSignalsHandler(
  options: CliSignalsHandlerOptions,
): (request: Request) => Promise<Response> {
  const readEnv = options.env ?? (() => process.env)
  const now = options.now ?? (() => new Date())
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  return async (request) => {
    if (!isJsonContentType(request.headers.get("content-type"))) return empty(415)

    const declaredLength = Number(request.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > CLI_INGEST_MAX_BODY_BYTES) {
      return empty(413)
    }
    const text = await readBoundedText(request, CLI_INGEST_MAX_BODY_BYTES)
    if (text === null) return empty(413)

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return empty(400)
    }

    const parsed = parseCliSignals(json)
    if (!parsed.ok || parsed.events.length === 0) return empty(400)

    const env = readEnv()
    const apiKey = env.NEXT_PUBLIC_POSTHOG_KEY
    if (env.GROWTH_CLI_SIGNALS_ENABLED === "true" && apiKey) {
      const receivedAt = now().toISOString()
      const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "")
      options.schedule(() => forwardToPostHog(parsed, { apiKey, host, receivedAt, send }))
    }

    return empty(202)
  }
}

/**
 * Request-level failures (schema, usage id, unknown event name, event count)
 * reject the whole request; an event with a bad property is dropped on its own.
 */
function parseCliSignals(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false }
  if (value.schema !== 1) return { ok: false }
  if (typeof value.usage_id !== "string" || !UUID.test(value.usage_id)) return { ok: false }
  const events = value.events
  if (!Array.isArray(events) || events.length < 1 || events.length > CLI_INGEST_MAX_EVENTS) {
    return { ok: false }
  }

  const accepted: AcceptedEvent[] = []
  for (const item of events) {
    if (!isRecord(item) || typeof item.event !== "string" || !isKnownEvent(item.event)) {
      return { ok: false }
    }
    const properties = acceptProperties(item.event, item.properties)
    if (properties) accepted.push({ event: item.event, properties })
  }

  return { ok: true, usageId: value.usage_id.toLowerCase(), events: accepted }
}

function acceptProperties(
  event: CliSignalEventName,
  raw: unknown,
): Record<string, string | number> | null {
  if (!isRecord(raw)) return null
  const rules: Readonly<Record<string, PropertyRule>> = CLI_SIGNAL_RULES[event]
  const accepted: Record<string, string | number> = {}

  for (const [name, rule] of Object.entries(rules)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined
    if (value === undefined) {
      if (rule.required) return null
      continue
    }
    if (rule.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) return null
    } else if (
      typeof value !== "string" ||
      value.length > CLI_INGEST_MAX_STRING_LENGTH ||
      (rule.values !== undefined && !rule.values.includes(value))
    ) {
      return null
    }
    accepted[name] = value
  }

  return accepted
}

async function forwardToPostHog(
  parsed: { readonly usageId: string; readonly events: readonly AcceptedEvent[] },
  target: {
    readonly apiKey: string
    readonly host: string
    readonly receivedAt: string
    readonly send: (input: string, init: RequestInit) => Promise<Response>
  },
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS)
  try {
    const response = await target.send(`${target.host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: target.apiKey,
        batch: parsed.events.map((event) => ({
          event: event.event,
          distinct_id: parsed.usageId,
          timestamp: target.receivedAt,
          properties: {
            ...event.properties,
            $ip: null,
            $geoip_disable: true,
            $process_person_profile: false,
            $lib: "b4-web-cli-ingest",
          },
        })),
      }),
      signal: controller.signal,
    })
    await response.body?.cancel().catch(() => undefined)
    // Status only: the log line never carries the usage id or any property.
    if (!response.ok) console.error(`CLI signals: PostHog replied ${response.status}`)
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown"
    console.error(`CLI signals: PostHog request failed (${name})`)
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function isJsonContentType(header: string | null): boolean {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() === "application/json"
}

function isKnownEvent(name: string): name is CliSignalEventName {
  return Object.hasOwn(CLI_SIGNAL_RULES, name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } })
}
