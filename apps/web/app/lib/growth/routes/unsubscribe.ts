import { stopContact } from "../contacts"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { verifyActionToken } from "../tokens"
import { renderConfirmPage, renderDonePage, renderFailurePage } from "../unsubscribe-page"
import { getSharedExecutor } from "./shared"

const MAX_BODY_BYTES = 4096

export interface UnsubscribeRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  now(): Date
}

function html(status: number, body: string): Response {
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

const failure = () => html(400, renderFailurePage())

function queryToken(request: Request): string | undefined {
  const token = new URL(request.url).searchParams.get("token")
  return token ? token : undefined
}

type BodyToken = { ok: true; token: string | undefined } | { ok: false }

async function bodyToken(request: Request): Promise<BodyToken> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false }
  const type = (request.headers.get("content-type") ?? "").toLowerCase()
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

export async function handleUnsubscribeGet(
  request: Request,
  deps: UnsubscribeRouteDeps,
): Promise<Response> {
  const token = queryToken(request)
  if (token === undefined) return failure()
  try {
    const verified = verifyActionToken({
      token,
      secret: deps.loadEnv().tokenSecret,
      purpose: "unsubscribe",
      now: deps.now(),
    })
    if (!verified.ok) return failure()
    return html(200, renderConfirmPage({ token }))
  } catch {
    return failure()
  }
}

export async function handleUnsubscribePost(
  request: Request,
  deps: UnsubscribeRouteDeps,
): Promise<Response> {
  const body = await bodyToken(request)
  if (!body.ok) return failure()
  const token = body.token ?? queryToken(request)
  if (token === undefined) return failure()

  try {
    const env = deps.loadEnv()
    const now = deps.now()
    const verified = verifyActionToken({
      token,
      secret: env.tokenSecret,
      purpose: "unsubscribe",
      now,
    })
    if (!verified.ok) return failure()
    await stopContact(deps.createExecutor(env.databaseUrl), {
      contactId: verified.contactId,
      reason: "unsubscribe",
      provenance: "unsubscribe_link",
      now,
    })
    // Already-stopped contacts get the same answer.
    return html(200, renderDonePage())
  } catch (error) {
    process.stderr.write(
      `unsubscribe failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    )
    return html(503, renderFailurePage())
  }
}

export function defaultUnsubscribeDeps(): UnsubscribeRouteDeps {
  return {
    loadEnv: () => loadGrowthEnv(),
    createExecutor: getSharedExecutor,
    now: () => new Date(),
  }
}
