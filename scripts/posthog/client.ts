import type { PosthogEnv } from "./env.js"

export interface PosthogClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
  patch<T>(path: string, body: unknown): Promise<T>
  delete(path: string): Promise<void>
}

const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 8000

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createPosthogClient(
  env: PosthogEnv,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): PosthogClient {
  const base = `${env.POSTHOG_HOST.replace(/\/+$/, "")}/api/projects/${env.POSTHOG_PROJECT_ID}`

  async function request(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : ""
    const url = `${base}/${path.replace(/^\/+/, "")}${search}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
    }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(url, init)
      if (response.ok) return response
      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS))
        continue
      }
      throw new Error(`PostHog ${method} ${path} failed with status ${response.status}`)
    }
  }

  return {
    async get<T>(path: string, query?: Record<string, string>): Promise<T> {
      return (await (await request("GET", path, query ? { query } : {})).json()) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return (await (await request("POST", path, { body })).json()) as T
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      return (await (await request("PATCH", path, { body })).json()) as T
    },
    async delete(path: string): Promise<void> {
      await request("DELETE", path)
    },
  }
}
