import { type ReactElement, useState } from "react"
import type { ApprovalView } from "../../view/turns.js"

export type ApprovalDecision = "once" | "always" | "deny"

export interface ApprovalCardProps {
  readonly approval: ApprovalView
  /** "The agent" for the root run, the subagent's name otherwise (spec §3.2). */
  readonly agent: string
  /** The gated step's running label, lower-cased by the caller: "run a command". */
  readonly label: string
  readonly onDecide: (decision: ApprovalDecision) => Promise<void> | void
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

/**
 * A subagent dispatch gate's detail (`kind: "subagent"`: `subagentName`,
 * `subagentRouteId`, `inputPreview`, `reason`) as labelled lines, or undefined
 * when the detail names no subagent.
 */
function subagentPayload(detail: Readonly<Record<string, unknown>>): string | undefined {
  const name = text(detail.subagentName)
  if (name === undefined) return undefined
  const route = text(detail.subagentRouteId)
  const input = text(detail.inputPreview)
  const reason = text(detail.reason)
  return [
    `Subagent: ${route !== undefined ? `${name} (${route})` : name}`,
    ...(input !== undefined ? [`Input: ${input}`] : []),
    ...(reason !== undefined ? [`Reason: ${reason}`] : []),
  ].join("\n")
}

/**
 * `detail.argsPreview`, else the command, else a subagent gate's name, input
 * and reason, else the detail as JSON without the scope hint; "No details"
 * when nothing is left or it cannot be serialised.
 */
export function approvalPayload(detail: Readonly<Record<string, unknown>>): string {
  const preview = text(detail.argsPreview) ?? text(detail.command) ?? subagentPayload(detail)
  if (preview !== undefined) return preview
  const { suggestedPattern: _omit, ...rest } = detail
  try {
    const json = JSON.stringify(rest, null, 2)
    return json === undefined || json === "{}" ? "No details" : json
  } catch {
    return "No details"
  }
}

/** The sentence under the buttons that says what "Always allow" covers (spec §3.2). */
export function scopeLine(kind: string, detail: Readonly<Record<string, unknown>>): string {
  if (detail.scope === "thread") return "“Always allow” applies in this conversation only."
  const pattern = text(detail.suggestedPattern)
  if (kind === "command") return "“Always allow” applies to this exact command, for this app."
  if (pattern !== undefined)
    return `“Always allow” applies to every call of ${pattern}, for this app.`
  if (kind === "tool") return "“Always allow” applies to every call of this tool, for this app."
  return "“Always allow” applies to this exact command, for this app."
}

/** The approval card (spec §3.2): one per pending interrupt, after the turn's activity. */
export function ApprovalCard({
  approval,
  agent,
  label,
  onDecide,
}: ApprovalCardProps): ReactElement {
  const [state, setState] = useState<"awaiting" | "deciding" | "failed">("awaiting")
  const [error, setError] = useState<string | undefined>(undefined)
  const decide = (decision: ApprovalDecision) => {
    setState("deciding")
    setError(undefined)
    // The executor runs synchronously, so the decision is dispatched on the click
    // itself; a synchronous throw and a rejected promise both land in `catch`.
    new Promise<void>((resolve) => resolve(onDecide(decision))).catch((cause: unknown) => {
      setState("failed")
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const busy = state === "deciding"
  return (
    <section
      className="b4-approval"
      data-state={state}
      role="alert"
      {...(busy ? { "aria-busy": true } : {})}
    >
      <h3 className="b4-approval__title">
        {agent} wants to {label}
      </h3>
      {approval.message ? <p className="b4-approval__reason">{approval.message}</p> : null}
      <pre className="b4-approval__payload">{approvalPayload(approval.detail)}</pre>
      <div className="b4-approval__actions">
        <button
          type="button"
          className="b4-approval__button b4-approval__button--primary"
          disabled={busy}
          onClick={() => decide("once")}
        >
          Allow once
        </button>
        {approval.offersAlways ? (
          <button
            type="button"
            className="b4-approval__button b4-approval__button--secondary"
            disabled={busy}
            onClick={() => decide("always")}
          >
            Always allow
          </button>
        ) : null}
        <button
          type="button"
          className="b4-approval__button b4-approval__button--text"
          disabled={busy}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
      </div>
      {error !== undefined ? (
        <p className="b4-approval__error">Couldn't send your decision: {error}</p>
      ) : null}
      {approval.offersAlways ? (
        <p className="b4-approval__scope">{scopeLine(approval.kind, approval.detail)}</p>
      ) : null}
    </section>
  )
}
