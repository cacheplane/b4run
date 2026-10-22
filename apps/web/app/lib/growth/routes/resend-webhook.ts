import { Webhook } from "standardwebhooks"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { parseResendEvent, processResendEvent } from "../webhooks"
import { getSharedExecutor } from "./shared"

// Bounce and complaint payloads can carry long SMTP diagnostics.
const MAX_BODY_BYTES = 65_536

export interface ResendWebhookRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  verify(input: {
    payload: string
    headers: { id: string; timestamp: string; signature: string }
    secret: string
  }): unknown
  now(): Date
}

const json = (status: number, body: Record<string, string>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const unverified = () => json(401, { error: "unverified" })

export async function handleResendWebhook(
  request: Request,
  deps: ResendWebhookRouteDeps,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: "too_large" })
  }

  try {
    const id = request.headers.get("svix-id")
    const timestamp = request.headers.get("svix-timestamp")
    const signature = request.headers.get("svix-signature")
    if (!id || !timestamp || !signature) return unverified()

    // The signature covers the exact bytes received, so verify the raw text before any parsing.
    const payload = await request.text()
    if (new TextEncoder().encode(payload).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "too_large" })
    }

    const env = deps.loadEnv()
    if (env.resendWebhookSecret === undefined) {
      process.stderr.write("resend webhook: RESEND_WEBHOOK_SECRET is not configured\n")
      return unverified()
    }
    let verified: unknown
    try {
      verified = deps.verify({
        payload,
        headers: { id, timestamp, signature },
        secret: env.resendWebhookSecret,
      })
    } catch {
      return unverified()
    }

    const event = parseResendEvent(verified)
    if (event === undefined) return json(202, { outcome: "ignored_type" })

    const outcome = await processResendEvent(deps.createExecutor(env.databaseUrl), {
      event,
      environment: env.environment,
      emailHmacSecret: env.emailHmacSecret,
      now: deps.now(),
    })
    return json(200, { outcome })
  } catch (error) {
    process.stderr.write(
      `resend webhook failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    )
    return json(503, { error: "unavailable" })
  }
}

export function defaultResendWebhookDeps(): ResendWebhookRouteDeps {
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
    now: () => new Date(),
  }
}
