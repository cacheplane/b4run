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

const NO_BODY_TOKEN: BodyToken = { ok: true, token: undefined }

function presentToken(value: FormDataEntryValue | string | null): BodyToken {
  return { ok: true, token: typeof value === "string" && value !== "" ? value : undefined }
}

async function parseBodyToken(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<BodyToken> {
  // An empty body carries no token whatever its type; the query token may still apply.
  if (bytes.byteLength === 0) return NO_BODY_TOKEN
  const type = contentType.toLowerCase()
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (typeof parsed !== "object" || parsed === null) return { ok: false }
      const token = (parsed as { token?: unknown }).token
      if (token === undefined) return NO_BODY_TOKEN
      return typeof token === "string" ? { ok: true, token } : { ok: false }
    } catch {
      return { ok: false }
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return presentToken(new URLSearchParams(new TextDecoder().decode(bytes)).get("token"))
  }
  if (type.includes("multipart/form-data")) {
    // RFC 8058 allows the one-click POST as multipart; it usually carries only
    // `List-Unsubscribe=One-Click`, so the token comes from the query.
    try {
      const form = await new Response(bytes, {
        headers: { "content-type": contentType },
      }).formData()
      return presentToken(form.get("token"))
    } catch {
      return NO_BODY_TOKEN
    }
  }
  // Any other body type carries no token; the query token applies.
  return NO_BODY_TOKEN
}

/** True when the declared body is already too large to read. */
export function declaresOversizeBody(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? "0")
  return Number.isFinite(declared) && declared > MAX_TOKEN_BODY_BYTES
}

/**
 * The token a signed-link POST carries, from its body or else its query; undefined when the
 * body is too large, is malformed JSON, or no token is present. A JSON, urlencoded or
 * multipart body may carry the token; any other body type is ignored in favour of the query.
 * Throws if the read fails.
 */
export async function readPostedToken(request: Request): Promise<string | undefined> {
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_TOKEN_BODY_BYTES) return undefined
  const body = await parseBodyToken(bytes, request.headers.get("content-type") ?? "")
  if (!body.ok) return undefined
  return body.token ?? queryToken(request)
}
