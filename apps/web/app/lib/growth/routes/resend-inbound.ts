import { Webhook } from "standardwebhooks"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { errorLogCode } from "../errors"
import {
  admitInboundReceipt,
  type ForwardDeps,
  type ForwardResult,
  forwardInboundReceipt,
  inboundRuntimeFor,
  parseInboundEvent,
} from "../inbound"
import { getSharedExecutor } from "./shared"

// An `email.received` event carries metadata only; the content is fetched from Resend.
const MAX_BODY_BYTES = 65_536

export interface ResendInboundRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  verify(input: {
    payload: string
    headers: { id: string; timestamp: string; signature: string }
    secret: string
  }): unknown
  /** Undefined when receiving is not configured. */
  forwardDeps(env: GrowthEnv): ForwardDeps | undefined
  forward(executor: SqlExecutor, id: string, deps: ForwardDeps): Promise<ForwardResult>
}

const json = (status: number, body: Record<string, string>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const unverified = () => json(401, { error: "unverified" })

const unavailable = (code: string) => {
  process.stderr.write(`resend inbound unavailable: ${code}\n`)
  return json(503, { error: "unavailable" })
}

/**
 * Receives Resend's `email.received` webhook. Only mail for brian@b4.run is admitted and
 * forwarded; anything else is acknowledged untouched. Logs carry codes only, never an address,
 * subject, body, or token.
 */
export async function handleResendInbound(
  request: Request,
  deps: ResendInboundRouteDeps,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: "too_large" })
  }

  const id = request.headers.get("svix-id")
  const timestamp = request.headers.get("svix-timestamp")
  const signature = request.headers.get("svix-signature")
  if (!id || !timestamp || !signature) return unverified()

  let env: GrowthEnv
  let forwardDeps: ForwardDeps | undefined
  try {
    env = deps.loadEnv()
    forwardDeps = deps.forwardDeps(env)
  } catch (error) {
    return unavailable(errorLogCode(error))
  }
  if (env.resendInboundWebhookSecret === undefined || forwardDeps === undefined) {
    return unavailable("inbound_disabled")
  }

  try {
    // The signature covers the exact bytes received, so verify the raw text before any parsing.
    const payload = await request.text()
    if (new TextEncoder().encode(payload).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "too_large" })
    }
    let verified: unknown
    try {
      verified = deps.verify({
        payload,
        headers: { id, timestamp, signature },
        secret: env.resendInboundWebhookSecret,
      })
    } catch {
      return unverified()
    }

    const event = parseInboundEvent(verified)
    if (event === undefined) return json(202, { outcome: "ignored_type" })
    if (!event.admitted) return json(200, { outcome: "ignored_recipient" })

    const executor = deps.createExecutor(env.databaseUrl)
    await admitInboundReceipt(executor, event)
    const result = await deps.forward(executor, event.id, forwardDeps)
    if (result.outcome === "retry") {
      // Resend retries a failed delivery, and the tick's recovery retries too.
      process.stderr.write(`resend inbound forward failed: ${result.code}\n`)
      return json(500, { error: "forward_failed" })
    }
    return json(200, { outcome: result.outcome })
  } catch (error) {
    process.stderr.write(`resend inbound failed: ${errorLogCode(error)}\n`)
    return json(500, { error: "forward_failed" })
  }
}

export function defaultResendInboundDeps(): ResendInboundRouteDeps {
  return {
    loadEnv: () => loadGrowthEnv(),
    createExecutor: getSharedExecutor,
    verify: ({ payload, headers, secret }) =>
      // Resend sends Svix-named headers; standardwebhooks reads the same values under webhook-* names.
      new Webhook(secret).verify(payload, {
        "webhook-id": headers.id,
        "webhook-timestamp": headers.timestamp,
        "webhook-signature": headers.signature,
      }),
    forwardDeps: (env) => inboundRuntimeFor(env),
    forward: forwardInboundReceipt,
  }
}
