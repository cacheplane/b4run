import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type { SqlExecutor } from "../database"
import { sendDailyDigest } from "../digest"
import { createResendMailer, type Mailer } from "../mailer"
import { isSendWindow } from "../schedule"
import {
  authoriseAndSend,
  enrollApprovedContacts,
  leaseDueSends,
  releaseLeases,
  SEND_BATCH,
  SEND_PACING_MS,
  type SendOutcome,
} from "../sequence"
import { loadSequenceEnv, type SequenceEnv } from "../sequence-env"
import { errorLogCode, getSharedExecutor } from "./shared"

/** The tick stops starting sends after this long, leaving room inside the 60-second route limit. */
export const TICK_SEND_BUDGET_MS = 40_000

export interface TickDeps {
  /** Read before anything else, so an unauthenticated call never parses the configuration. */
  cronSecret(): string | undefined
  loadEnv(): SequenceEnv
  createExecutor(url: string): SqlExecutor
  createMailer(apiKey: string): Mailer
  now(): Date
  randomUUID(): string
  elapsedMs(): number
  sleep(ms: number): Promise<void>
}

export type TickDelivery = "disabled" | "enabled" | "missing_api_key"

export interface TickReport {
  readonly enrolled: number
  readonly leased: number
  readonly outcomes: Readonly<Partial<Record<SendOutcome, number>>>
  readonly digest: string
  readonly windowOpen: boolean
  readonly delivery: TickDelivery
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

const sha256 = (value: string) => createHash("sha256").update(value).digest()

/** Compares digests of equal length, so neither the secret nor its length leaks through timing. */
function isAuthorised(request: Request, cronSecret: string | undefined): boolean {
  if (cronSecret === undefined) return false
  const header = request.headers.get("authorization")
  if (header === null) return false
  return timingSafeEqual(sha256(header), sha256(`Bearer ${cronSecret}`))
}

async function runSends(
  executor: SqlExecutor,
  env: SequenceEnv,
  mailer: Mailer,
  deps: TickDeps,
): Promise<{ leased: number; outcomes: Partial<Record<SendOutcome, number>> }> {
  const outcomes: Partial<Record<SendOutcome, number>> = {}
  let leased = 0
  let started = 0
  const overBudget = () => deps.elapsedMs() > TICK_SEND_BUDGET_MS
  while (!overBudget()) {
    const leaseToken = deps.randomUUID()
    const batch = await leaseDueSends(executor, {
      now: deps.now(),
      limit: SEND_BATCH,
      leaseToken,
    })
    if (batch.length === 0) break
    leased += batch.length
    for (const [index, send] of batch.entries()) {
      if (started > 0) await deps.sleep(SEND_PACING_MS)
      // Checked after the pacing wait, so no send starts once the budget is spent.
      if (overBudget()) {
        // Hand the rest back now rather than leaving them until their leases expire.
        await releaseLeases(executor, {
          leaseToken,
          ids: batch.slice(index).map((unstarted) => unstarted.id),
        })
        return { leased, outcomes }
      }
      started += 1
      const outcome = await authoriseAndSend(executor, { send, env, mailer, now: deps.now() })
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    }
  }
  return { leased, outcomes }
}

/**
 * The 30-minute cron: enrolls newly approved contacts, sends what is due inside the Pacific
 * window, then the founder digest. The report carries counts only, never ids or addresses.
 */
export async function handleTick(request: Request, deps: TickDeps): Promise<Response> {
  try {
    if (!isAuthorised(request, deps.cronSecret())) return json(401, { error: "unauthorized" })
    const env = deps.loadEnv()

    const executor = deps.createExecutor(env.databaseUrl)
    const now = deps.now()
    let enrolled = 0
    if (env.sequenceEnabled) {
      // loadSequenceEnv already refuses this; never enroll without the launch time.
      if (env.sequenceStartAt === undefined) throw new Error("sequence start time missing")
      enrolled = (await enrollApprovedContacts(executor, { startAt: env.sequenceStartAt, now }))
        .enrolled
    }

    const windowOpen = isSendWindow(now)
    let leased = 0
    let outcomes: Partial<Record<SendOutcome, number>> = {}
    let digest = "disabled"
    let delivery: TickDelivery = "disabled"
    if (env.deliveryEnabled) {
      if (env.resendApiKey === undefined) {
        delivery = "missing_api_key"
        digest = "skipped"
      } else {
        delivery = "enabled"
        const mailer = deps.createMailer(env.resendApiKey)
        if (windowOpen) ({ leased, outcomes } = await runSends(executor, env, mailer, deps))
        digest = await sendDailyDigest(executor, { env, mailer, now: deps.now() })
      }
    }

    const report: TickReport = { enrolled, leased, outcomes, digest, windowOpen, delivery }
    return json(200, report)
  } catch (error) {
    process.stderr.write(`growth tick failed: ${errorLogCode(error)}\n`)
    return json(500, { error: "tick_failed" })
  }
}

export function defaultTickDeps(): TickDeps {
  const startedAt = performance.now()
  return {
    cronSecret: () => process.env.CRON_SECRET?.trim() || undefined,
    loadEnv: () => loadSequenceEnv(),
    createExecutor: getSharedExecutor,
    createMailer: (apiKey) => createResendMailer(apiKey),
    now: () => new Date(),
    randomUUID: () => randomUUID(),
    elapsedMs: () => performance.now() - startedAt,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
