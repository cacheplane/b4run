import { acceptFounderUpdatesForm } from "../contacts"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { parseFounderUpdatesSubmission } from "../forms"
import { createRateLimiter, FORM_RATE_LIMIT } from "../rate-limit"
import { createPosthogServerClient, noopSignalClient, type ServerSignalClient } from "../signals"

import { getSharedExecutor } from "./shared"

const MAX_BODY_BYTES = 4096

export interface FounderUpdatesRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  createSignals(key: string | undefined): ServerSignalClient
  limiter: { allow(key: string): boolean }
  now(): Date
  randomUUID(): string
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return first ? first : "unknown"
}

export async function handleFounderUpdatesPost(
  request: Request,
  deps: FounderUpdatesRouteDeps,
): Promise<Response> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return json(400, { error: "invalid_body" })
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json(400, { error: "invalid_body" })
  }

  const parsed = parseFounderUpdatesSubmission(body)
  if (!parsed.ok) {
    if (parsed.error === "honeypot") return json(200, { ok: true })
    return json(400, { error: parsed.error })
  }

  if (!deps.limiter.allow(clientIp(request))) return json(429, { error: "rate_limited" })

  const submission = parsed.value
  try {
    const env = deps.loadEnv()
    const executor = deps.createExecutor(env.databaseUrl)
    const result = await acceptFounderUpdatesForm(executor, env.emailHmacSecret, {
      email: submission.email,
      ...(submission.message !== undefined ? { message: submission.message } : {}),
      ...(submission.posthogDistinctId !== undefined
        ? { posthogDistinctId: submission.posthogDistinctId }
        : {}),
      disclosureVersion: submission.disclosureVersion,
      submissionId: submission.submissionId,
      now: deps.now(),
    })
    // A conversion is a new, approved contact; re-submissions and stopped contacts emit nothing.
    if (result.created && result.approved) {
      try {
        await deps.createSignals(env.posthogKey).capture({
          distinctId: submission.posthogDistinctId ?? deps.randomUUID(),
          event: "site:contact_accepted",
          properties: { form: "founder_updates", email_kind: result.emailKind },
        })
      } catch {
        // The contact is stored; a signal failure is not the visitor's problem.
      }
    }
    // The same answer whether or not the contact was approved: a stop is never disclosed.
    return json(200, { ok: true })
  } catch (error) {
    process.stderr.write(
      `founder-updates form failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    )
    return json(503, { error: "unavailable" })
  }
}

let signals: { key: string; client: ServerSignalClient } | undefined
let limiter: { allow(key: string): boolean } | undefined

export function defaultFounderUpdatesDeps(): FounderUpdatesRouteDeps {
  limiter ??= createRateLimiter(FORM_RATE_LIMIT)
  return {
    loadEnv: () => loadGrowthEnv(),
    createExecutor: getSharedExecutor,
    createSignals(key) {
      if (key === undefined) return noopSignalClient()
      if (signals?.key !== key) signals = { key, client: createPosthogServerClient(key) }
      return signals.client
    },
    limiter,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
  }
}
