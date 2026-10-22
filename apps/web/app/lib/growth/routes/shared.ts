import { createPgExecutor, type SqlExecutor } from "../database"

let executor: { url: string; value: SqlExecutor } | undefined

/**
 * One memoised pool per server process, shared by every growth route. The first
 * URL wins for the process lifetime; a later call with a different URL throws.
 */
export function getSharedExecutor(url: string): SqlExecutor {
  if (executor === undefined) executor = { url, value: createPgExecutor(url) }
  else if (executor.url !== url) {
    throw new Error("growth executor already created for a different database URL")
  }
  return executor.value
}

const MAX_TOKEN_BODY_BYTES = 4096

/** An HTML answer for a signed-link page: never cached, never indexed, never leaks the URL. */
export function privateHtml(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  })
}

export function queryToken(request: Request): string | undefined {
  const token = new URL(request.url).searchParams.get("token")
  return token ? token : undefined
}

type BodyToken = { ok: true; token: string | undefined } | { ok: false }

function parseBodyToken(text: string, contentType: string): BodyToken {
  // An empty body carries no token whatever its type; the query token may still apply.
  if (text === "") return { ok: true, token: undefined }
  const type = contentType.toLowerCase()
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null) return { ok: false }
      const token = (parsed as { token?: unknown }).token
      if (token === undefined) return { ok: true, token: undefined }
      return typeof token === "string" ? { ok: true, token } : { ok: false }
    } catch {
      return { ok: false }
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const token = new URLSearchParams(text).get("token")
    return { ok: true, token: token ? token : undefined }
  }
  return { ok: false }
}

/** True when the declared body is already too large to read. */
export function declaresOversizeBody(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? "0")
  return Number.isFinite(declared) && declared > MAX_TOKEN_BODY_BYTES
}

/**
 * The token a signed-link POST carries, from its body or else its query; undefined when the
 * body is too large, unsupported, malformed, or no token is present. Throws if the read fails.
 */
export async function readPostedToken(request: Request): Promise<string | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_TOKEN_BODY_BYTES) return undefined
  const body = parseBodyToken(text, request.headers.get("content-type") ?? "")
  if (!body.ok) return undefined
  return body.token ?? queryToken(request)
}
