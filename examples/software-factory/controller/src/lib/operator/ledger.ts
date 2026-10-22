import type { FactoryEvent, WorkOrderRow } from "../domain/work-order.js"
import { costOf, type PriceTable } from "./prices.js"

/**
 * The ledger: one row per work order, computed from the journal and the row alone, so a
 * run is costed after the fact from what the controller recorded while it ran. The RFC's
 * principal metric is cost per accepted change (§13); these rows are its numerator's parts,
 * with every money figure marked estimated and the price table it came from named.
 *
 * Human active minutes are not recorded anywhere: the ledger reports what a person had to
 * read (drafts and bundles) and how long the row waited at each gate, which are the proxies.
 */

export type LedgerPhase = "intake" | "build"

export interface PhaseUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  /** USD under the price table, or null when a call's model has no price. */
  readonly estimatedUsd: number | null
  /** Models seen, with the calls each made. */
  readonly models: Readonly<Record<string, number>>
}

export interface LedgerRow {
  readonly id: string
  readonly origin: string
  readonly targetId: string | null
  readonly pin: string | null
  readonly state: string
  readonly outcome: string
  readonly intakeAttempts: number
  readonly candidateAttempts: number
  /** Milliseconds, each summed over the attempts that ran it. */
  readonly ms: {
    readonly intake: number
    readonly imageBuild: number
    readonly build: number
    readonly verify: number
    readonly delivery: number
    /** Time parked at the two gates, waiting on a person. */
    readonly waiting: number
    /** Created to the last journal line. */
    readonly wall: number
    /** The row's own active-budget ticker. */
    readonly active: number
  }
  /** What a person read: drafts parked for review and bundles parked for approval. */
  readonly gates: { readonly drafts: number; readonly bundles: number }
  /** Null when the journal carries no `model_usage` line (a run before the ledger existed). */
  readonly usage: {
    readonly intake: PhaseUsage
    readonly build: PhaseUsage
    readonly total: PhaseUsage
  } | null
  readonly estimatedUsd: number | null
  readonly priceTableAsOf: string
}

const EMPTY: PhaseUsage = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedUsd: 0,
  models: {},
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function at(event: FactoryEvent): number {
  return Date.parse(event.at)
}

function addUsage(into: PhaseUsage, event: FactoryEvent, prices: PriceTable): PhaseUsage {
  const p = event.payload
  const model = typeof p.model === "string" ? p.model : "unknown"
  const counts = {
    inputTokens: number(p.inputTokens),
    cachedInputTokens: number(p.cachedInputTokens),
    outputTokens: number(p.outputTokens),
  }
  const price = prices.models[model]
  const usd = price === undefined ? null : costOf(price, counts)
  return {
    calls: into.calls + 1,
    inputTokens: into.inputTokens + counts.inputTokens,
    cachedInputTokens: into.cachedInputTokens + counts.cachedInputTokens,
    outputTokens: into.outputTokens + counts.outputTokens,
    reasoningTokens: into.reasoningTokens + number(p.reasoningTokens),
    estimatedUsd: into.estimatedUsd === null || usd === null ? null : into.estimatedUsd + usd,
    models: { ...into.models, [model]: (into.models[model] ?? 0) + 1 },
  }
}

function sumUsage(a: PhaseUsage, b: PhaseUsage): PhaseUsage {
  const models: Record<string, number> = { ...a.models }
  for (const [model, calls] of Object.entries(b.models))
    models[model] = (models[model] ?? 0) + calls
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    estimatedUsd:
      a.estimatedUsd === null || b.estimatedUsd === null ? null : a.estimatedUsd + b.estimatedUsd,
    models,
  }
}

/**
 * Sum the spans between an opening and a closing transition, in journal order: each opener
 * is closed by the next closer after it, so repeated attempts each count once and an opener
 * never closed (the row still in that phase) contributes nothing.
 */
function spans(
  events: readonly FactoryEvent[],
  opens: (e: FactoryEvent) => boolean,
  closes: (e: FactoryEvent) => boolean,
): number {
  let total = 0
  let open: number | null = null
  for (const event of events) {
    if (opens(event)) {
      if (open === null) open = at(event)
    } else if (closes(event) && open !== null) {
      total += Math.max(0, at(event) - open)
      open = null
    }
  }
  return total
}

const transition = (event: FactoryEvent, name: string) =>
  event.type === "transition" && event.payload.event === name
const transitionTo = (event: FactoryEvent, state: string) =>
  event.type === "transition" && event.payload.to === state

function outcomeOf(row: WorkOrderRow, events: readonly FactoryEvent[]): string {
  if (row.state === "delivered") {
    const pr = events.find(
      (e) =>
        e.type === "delivery_confirmed" ||
        (e.type === "transition" && e.payload.event === "delivery_confirmed"),
    )
    const number = pr?.payload.number
    return typeof number === "number" ? `delivered #${number}` : "delivered"
  }
  if (row.state === "exported") return "exported"
  if (row.state === "blocked") return `blocked: ${row.blockedReason ?? "unknown"}`
  if (row.state === "failed") return `failed: ${row.failureReason ?? "unknown"}`
  return row.state
}

export function ledgerRow(
  row: WorkOrderRow,
  events: readonly FactoryEvent[],
  prices: PriceTable,
): LedgerRow {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let intake = EMPTY
  let build = EMPTY
  let sawUsage = false
  for (const event of ordered) {
    if (event.type !== "model_usage") continue
    sawUsage = true
    if (event.payload.phase === "intake") intake = addUsage(intake, event, prices)
    else build = addUsage(build, event, prices)
  }
  const total = sumUsage(intake, build)
  const first = ordered[0]
  const last = ordered.at(-1)
  const ms = {
    intake: spans(
      ordered,
      (e) => transition(e, "intake_started") || transition(e, "intake_retry"),
      (e) => transition(e, "intake_drafted") || transition(e, "intake_blocked"),
    ),
    imageBuild: ordered
      .filter((e) => e.type === "image_prepared")
      .reduce((sum, e) => sum + number(e.payload.ms), 0),
    build: spans(
      ordered,
      (e) => transition(e, "run_started"),
      (e) =>
        transition(e, "turn_ended_with_workspace") ||
        transition(e, "turn_ended_without_changes") ||
        transition(e, "run_failed") ||
        transition(e, "unexpected_interrupt"),
    ),
    verify: spans(
      ordered,
      (e) => transition(e, "turn_ended_with_workspace"),
      (e) =>
        transition(e, "receipt_passed") ||
        transition(e, "receipt_failed") ||
        transition(e, "receipt_inconclusive") ||
        transition(e, "assembly_rejected"),
    ),
    delivery: spans(
      ordered,
      (e) => transition(e, "approve_delivery") || transition(e, "approve"),
      (e) =>
        transition(e, "delivery_confirmed") ||
        transition(e, "delivery_refused") ||
        transition(e, "receipt_observed") ||
        transition(e, "export_unconfirmed"),
    ),
    waiting:
      spans(
        ordered,
        (e) => transitionTo(e, "awaiting_intake_approval"),
        (e) => transition(e, "approve_intake") || transition(e, "reject_intake"),
      ) +
      spans(
        ordered,
        (e) => transitionTo(e, "awaiting_approval"),
        (e) => e.type === "approve_started" || transition(e, "deny"),
      ),
    wall: first !== undefined && last !== undefined ? Math.max(0, at(last) - at(first)) : 0,
    active: row.activeMs,
  }
  const origin =
    row.origin.kind === "issue"
      ? `${row.origin.repository}#${row.origin.number}`
      : `task ${row.taskId}`
  return {
    id: row.id,
    origin,
    targetId: row.targetId,
    pin: row.pin,
    state: row.state,
    outcome: outcomeOf(row, ordered),
    intakeAttempts: row.intakeAttempts,
    candidateAttempts: row.candidateAttempts,
    ms,
    gates: {
      drafts: ordered.filter((e) => transitionTo(e, "awaiting_intake_approval")).length,
      bundles: ordered.filter((e) => transitionTo(e, "awaiting_approval")).length,
    },
    usage: sawUsage ? { intake, build, total } : null,
    estimatedUsd: sawUsage ? total.estimatedUsd : null,
    priceTableAsOf: prices.asOf,
  }
}

const minutes = (ms: number) => (ms === 0 ? "-" : `${(ms / 60_000).toFixed(1)}m`)
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n)
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(3)}`)

/** A fixed-width table for a terminal, one line per work order, and a legend. */
export function renderLedger(rows: readonly LedgerRow[]): string {
  const header = [
    "work order",
    "origin",
    "target",
    "intake",
    "cand.",
    "intake",
    "image",
    "build",
    "verify",
    "deliver",
    "waiting",
    "wall",
    "tokens in/out",
    "est. cost",
    "outcome",
  ]
  const lines = rows.map((r) => [
    r.id,
    r.origin,
    r.targetId ?? "-",
    String(r.intakeAttempts),
    String(r.candidateAttempts),
    minutes(r.ms.intake),
    minutes(r.ms.imageBuild),
    minutes(r.ms.build),
    minutes(r.ms.verify),
    minutes(r.ms.delivery),
    minutes(r.ms.waiting),
    minutes(r.ms.wall),
    r.usage ? `${tokens(r.usage.total.inputTokens)}/${tokens(r.usage.total.outputTokens)}` : "n/a",
    usd(r.estimatedUsd),
    r.outcome,
  ])
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map((l) => (l[i] as string).length)),
  )
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd()
  const accepted = rows.filter((r) => r.state === "delivered" || r.state === "exported")
  const costed = accepted.filter((r) => r.estimatedUsd !== null)
  const spent = costed.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0)
  const asOf = rows[0]?.priceTableAsOf ?? "-"
  return [
    fmt(header),
    fmt(widths.map((w) => "-".repeat(w))),
    ...lines.map(fmt),
    "",
    `attempts: intake / candidate. minutes: intake = drafter turns and oracle proofs; image = image builds (budget paused); build = builder turns; verify = verifications; deliver = approval to delivered; waiting = parked at a gate.`,
    `cost: estimated from the price table as of ${asOf} (FACTORY_PRICES_JSON overrides); n/a = no model_usage in the journal (a run before the ledger).`,
    `accepted: ${accepted.length} of ${rows.length}; estimated cost per accepted change over the ${costed.length} costed: ${costed.length === 0 ? "n/a" : usd(spent / costed.length)}.`,
  ].join("\n")
}

/** The same rows as a Markdown table, for a ledger file kept in the repository. */
export function renderLedgerMarkdown(rows: readonly LedgerRow[]): string {
  const header =
    "| work order | origin | target | attempts (intake/cand.) | intake | image | build | verify | deliver | waiting | tokens in/out | est. cost | outcome |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  const lines = rows.map(
    (r) =>
      `| \`${r.id}\` | ${r.origin} | ${r.targetId ?? "-"} | ${r.intakeAttempts}/${r.candidateAttempts} | ${minutes(r.ms.intake)} | ${minutes(r.ms.imageBuild)} | ${minutes(r.ms.build)} | ${minutes(r.ms.verify)} | ${minutes(r.ms.delivery)} | ${minutes(r.ms.waiting)} | ${r.usage ? `${tokens(r.usage.total.inputTokens)}/${tokens(r.usage.total.outputTokens)}` : "n/a"} | ${usd(r.estimatedUsd)} | ${r.outcome} |`,
  )
  const asOf = rows[0]?.priceTableAsOf ?? "-"
  return [
    header,
    sep,
    ...lines,
    "",
    `Cost is estimated from the price table as of ${asOf}; n/a marks a run journalled before the ledger existed.`,
    "",
  ].join("\n")
}
