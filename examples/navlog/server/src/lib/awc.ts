/**
 * Minimal aviationweather.gov Data API client. No key. The public limit is
 * 100 requests a minute across every caller, so every response is cached
 * in-process for five minutes keyed by the full URL. `B4_AWC_BASE_URL`
 * overrides the base for tests and stubs.
 */
export type AwcProduct =
  | "airport"
  | "metar"
  | "taf"
  | "windtemp"
  | "gairmet"
  | "airsigmet"
  | "stationinfo"
  | "navaid"

export const AWC_DEFAULT_BASE_URL = "https://aviationweather.gov/api/data"
const TTL_MS = 5 * 60_000
/** A request that has not answered in this long is abandoned, so a hung upstream cannot stall a run. */
const DEFAULT_TIMEOUT_MS = 10_000

interface CacheEntry {
  readonly at: number
  readonly body: string
}

export class AwcClient {
  readonly #baseUrl: string
  readonly #now: () => number
  readonly #timeoutMs: number
  readonly #cache = new Map<string, CacheEntry>()

  constructor(
    options: {
      readonly baseUrl?: string
      readonly now?: () => number
      readonly timeoutMs?: number
    } = {},
  ) {
    this.#baseUrl = (
      options.baseUrl ??
      process.env.B4_AWC_BASE_URL ??
      AWC_DEFAULT_BASE_URL
    ).replace(/\/$/, "")
    this.#now = options.now ?? Date.now
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  url(product: AwcProduct, params: Readonly<Record<string, string>>): string {
    const query = new URLSearchParams(params)
    return `${this.#baseUrl}/${product}?${query.toString()}`
  }

  async getText(
    product: AwcProduct,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = this.url(product, params)
    const cached = this.#cache.get(url)
    const now = this.#now()
    if (cached && now - cached.at <= TTL_MS) return cached.body
    // The caller's signal (the run being cancelled) and our own deadline, whichever fires first.
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const response = await fetch(url, {
      headers: { accept: "application/json, text/plain" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error(`aviationweather.gov ${product} returned ${response.status}`)
    // 204 No Content means "nothing matched"; keep it as an empty body.
    const body = response.status === 204 ? "" : await response.text()
    this.#cache.set(url, { at: now, body })
    return body
  }

  async getJson<T>(
    product: AwcProduct,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = await this.getText(product, { ...params, format: "json" }, signal)
    // Every JSON product used here is an array; an empty answer (204 or a blank
    // body) is an empty array, not a parse error.
    if (body.trim() === "") return [] as T
    return JSON.parse(body) as T
  }
}

/** One shared client per process, so the cache is shared by every tool call. */
export const awc = new AwcClient()
