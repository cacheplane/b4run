import type { Interrupt, ResumeEntry } from "@ag-ui/core"
import type { ApprovalDecision } from "./activity-approval.js"
import type { ApprovalView } from "./turns.js"

/** A decision on one parked interrupt, as an approval card reports it. */
export interface InterruptDecision {
  readonly interruptId: string
  readonly decision: ApprovalDecision
}

/**
 * A parked interrupt to answer: AG-UI's `Interrupt` (from `RUN_FINISHED`'s
 * interrupt outcome, grant at `metadata.grant`) or an `ApprovalView` (from
 * `pendingApprovals`, grant at `grant`).
 */
export type ResumableInterrupt =
  | Pick<Interrupt, "id" | "metadata">
  | Pick<ApprovalView, "interruptId" | "grant">

/**
 * What `toResumeEntries` returns: the entries for `RunAgentInput.resume`, or
 * why there are none yet.
 *
 * - `undecided`: some parked interrupts have no decision (`interruptIds`).
 *   B4.run resumes a thread only when every parked interrupt is answered at
 *   once, so collect the rest first.
 * - `unknown_interrupt`: decisions name interrupts that are not parked
 *   (`interruptIds`) — stale cards from an earlier park.
 * - `no_interrupts`: nothing is parked; there is nothing to resume.
 */
export type ResumeEntriesResult =
  | { readonly ok: true; readonly entries: ResumeEntry[] }
  | {
      readonly ok: false
      readonly reason: "undecided" | "unknown_interrupt" | "no_interrupts"
      readonly interruptIds: readonly string[]
    }

function idOf(interrupt: ResumableInterrupt): string {
  return "interruptId" in interrupt ? interrupt.interruptId : interrupt.id
}

function grantOf(interrupt: ResumableInterrupt): string | undefined {
  if ("interruptId" in interrupt) return interrupt.grant
  const grant = (interrupt.metadata as { readonly grant?: unknown } | undefined)?.grant
  return typeof grant === "string" ? grant : undefined
}

/**
 * The AG-UI 1.0 `resume` entries for a set of approval decisions, exactly as
 * B4.run's resume expects them and as the CopilotKit connectors send them:
 * `once` and `always` resolve the interrupt with that payload, `deny` cancels
 * it (no payload), and the interrupt's single-use approval grant, when it
 * carries one, is echoed at `metadata.grant`. Entries follow the order of
 * `interrupts`. Pure: it reads nothing but its arguments.
 *
 * Every parked interrupt must be decided — a resume that leaves one out is
 * refused — so until all are, the result is `{ ok: false, reason:
 * "undecided" }` naming the rest. A later decision for the same interrupt
 * replaces an earlier one.
 *
 * ```ts
 * const result = toResumeEntries(decisions, interrupts)
 * if (result.ok) agent.runAgent({ resume: result.entries })
 * ```
 */
export function toResumeEntries(
  decisions: readonly InterruptDecision[],
  interrupts: readonly ResumableInterrupt[],
): ResumeEntriesResult {
  if (interrupts.length === 0) return { ok: false, reason: "no_interrupts", interruptIds: [] }
  const parked = new Set(interrupts.map(idOf))
  const decided = new Map<string, ApprovalDecision>()
  for (const { interruptId, decision } of decisions) decided.set(interruptId, decision)
  const unknown = [...decided.keys()].filter((id) => !parked.has(id))
  if (unknown.length > 0) return { ok: false, reason: "unknown_interrupt", interruptIds: unknown }
  const undecided = [...parked].filter((id) => !decided.has(id))
  if (undecided.length > 0) return { ok: false, reason: "undecided", interruptIds: undecided }
  const seen = new Set<string>()
  const entries: ResumeEntry[] = []
  for (const interrupt of interrupts) {
    const interruptId = idOf(interrupt)
    if (seen.has(interruptId)) continue
    seen.add(interruptId)
    const decision = decided.get(interruptId) as ApprovalDecision
    const grant = grantOf(interrupt)
    entries.push({
      interruptId,
      ...(decision === "deny"
        ? { status: "cancelled" as const }
        : { status: "resolved" as const, payload: decision }),
      ...(grant !== undefined ? { metadata: { grant } } : {}),
    })
  }
  return { ok: true, entries }
}
