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
  | "sigmet"
  | "stationinfo"
  | "navaid"

export const AWC_DEFAULT_BASE_URL = "https://aviationweather.gov/api/data"
const TTL_MS = 5 * 60_000

interface CacheEntry {
  readonly at: number
  readonly body: string
}

export class AwcClient {
  readonly #baseUrl: string
  readonly #now: () => number
  readonly #cache = new Map<string, CacheEntry>()

  constructor(options: { readonly baseUrl?: string; readonly now?: () => number } = {}) {
    this.#baseUrl = (
      options.baseUrl ??
      process.env.B4_AWC_BASE_URL ??
      AWC_DEFAULT_BASE_URL
    ).replace(/\/$/, "")
    this.#now = options.now ?? Date.now
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
    const response = await fetch(url, {
      headers: { accept: "application/json, text/plain" },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new Error(`aviationweather.gov ${product} returned ${response.status}`)
    const body = await response.text()
    this.#cache.set(url, { at: now, body })
    return body
  }

  async getJson<T>(
    product: AwcProduct,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = await this.getText(product, { ...params, format: "json" }, signal)
    return JSON.parse(body) as T
  }
}

/** One shared client per process, so the cache is shared by every tool call. */
export const awc = new AwcClient()
