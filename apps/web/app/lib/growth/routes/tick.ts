import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type { SqlExecutor } from "../database"
import { sendDailyDigest } from "../digest"
import { errorLogCode, GrowthConfigError } from "../errors"
import {
  type InboundReport,
  type InboundRuntime,
  inboundRuntimeFor,
  recoverInbound,
} from "../inbound"
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
import { getSharedExecutor } from "./shared"

/** The tick stops starting sends after this long, leaving room inside the 60-second route limit. */
export const TICK_SEND_BUDGET_MS = 40_000
/**
 * Inbound recovery starts no list page or forward after this long. A forward's worst case
 * (receiving read, raw download, send) is about 25 seconds, so it still ends inside the limit.
 */
export const TICK_INBOUND_BUDGET_MS = 30_000

export interface TickDeps {
  /** Read before anything else, so an unauthenticated call never parses the configuration. */
  cronSecret(): string | undefined
  loadEnv(): SequenceEnv
  createExecutor(url: string): SqlExecutor
  createMailer(apiKey: string): Mailer
  /** Undefined when receiving is not configured. */
  inboundRuntime(env: SequenceEnv): InboundRuntime | undefined
  now(): Date
  randomUUID(): string
  elapsedMs(): number
  sleep(ms: number): Promise<void>
}

export type TickDelivery = "disabled" | "enabled"

export interface TickReport {
  readonly enrolled: number
  readonly leased: number
  readonly outcomes: Readonly<Partial<Record<SendOutcome, number>>>
  readonly digest: string
  readonly windowOpen: boolean
  readonly delivery: TickDelivery
  readonly inbound: InboundReport | "disabled"
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
 * The 10-minute cron: enrolls newly approved contacts, sends what is due inside the Pacific
 * window, then the founder digest, then recovers inbound mail for brian@b4.run. The report
 * carries counts only, never ids or addresses.
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
      if (env.sequenceStartAt === undefined) {
        throw new GrowthConfigError("GROWTH_SEQUENCE_START_AT is not set")
      }
      enrolled = (await enrollApprovedContacts(executor, { startAt: env.sequenceStartAt, now }))
        .enrolled
    }

    const windowOpen = isSendWindow(now)
    let leased = 0
    let outcomes: Partial<Record<SendOutcome, number>> = {}
    let digest = "disabled"
    let delivery: TickDelivery = "disabled"
    if (env.deliveryEnabled) {
      // loadSequenceEnv already refuses delivery without a key; this only narrows the type.
      if (env.resendApiKey === undefined) throw new GrowthConfigError("RESEND_API_KEY is not set")
      delivery = "enabled"
      const mailer = deps.createMailer(env.resendApiKey)
      if (windowOpen) ({ leased, outcomes } = await runSends(executor, env, mailer, deps))
      digest = await sendDailyDigest(executor, { env, mailer, now: deps.now() })
    }

    // Independent of both switches: forwarding the founder's mail is not a send to contacts.
    let inbound: InboundReport | "disabled" = "disabled"
    const runtime = deps.inboundRuntime(env)
    if (runtime !== undefined) {
      inbound = await recoverInbound(executor, {
        ...runtime,
        now: deps.now,
        canContinue: () => deps.elapsedMs() < TICK_INBOUND_BUDGET_MS,
      })
    }

    const report: TickReport = {
      enrolled,
      leased,
      outcomes,
      digest,
      windowOpen,
      delivery,
      inbound,
    }
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
    inboundRuntime: (env) => inboundRuntimeFor(env),
    now: () => new Date(),
    randomUUID: () => randomUUID(),
    elapsedMs: () => performance.now() - startedAt,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
