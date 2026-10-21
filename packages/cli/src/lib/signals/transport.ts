import type { SignalEvent } from "./events.js"

export const DEFAULT_SIGNALS_URL = "https://b4.run/api/signals/v1/cli"
export const SIGNALS_TIMEOUT_MS = 3000
export const SIGNALS_SCHEMA_VERSION = 1

export function resolveSignalsUrl(env: Readonly<Record<string, string | undefined>>): string {
  const candidate = env.B4_SIGNALS_URL
  if (candidate === undefined) return DEFAULT_SIGNALS_URL
  try {
    const { protocol } = new URL(candidate)
    return protocol === "http:" || protocol === "https:" ? candidate : DEFAULT_SIGNALS_URL
  } catch {
    return DEFAULT_SIGNALS_URL
  }
}

export interface SignalsRequestBody {
  readonly schema: 1
  readonly usage_id: string
  readonly sent_at: string
  readonly events: readonly SignalEvent[]
}

export type FetchLike = (
  input: string,
  init: {
    method: "POST"
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<unknown>

export interface SendSignalsOptions {
  readonly url: string
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
}

/** POST one usage-signals body. Never rejects, never logs, bounded by a timeout. */
export async function sendSignals(
  body: SignalsRequestBody,
  options: SendSignalsOptions,
): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SIGNALS_TIMEOUT_MS)
    timer.unref()
    const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    await doFetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "b4-cli" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    // Intentionally silent: usage reporting must never surface errors to the user.
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Abort after settling so an unread response body releases its socket.
    controller.abort()
  }
}
