import { type ReactElement, useState } from "react"
import {
  type ApprovalDecision,
  approvalErrorLine,
  approvalPayload,
  dispatchDecision,
  scopeLine,
} from "../../view/activity-approval.js"
import type { ApprovalView } from "../../view/turns.js"

export type { ApprovalDecision }

export interface ApprovalCardProps {
  readonly approval: ApprovalView
  /** "The agent" for the root run, the subagent's name otherwise (spec §3.2). */
  readonly agent: string
  /** The gated step's running label, lower-cased by the caller: "run a command". */
  readonly label: string
  readonly onDecide: (decision: ApprovalDecision) => Promise<void> | void
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
    // Dispatched on the click itself; a synchronous throw and a rejected
    // promise both land in the error callback.
    dispatchDecision(
      () => onDecide(decision),
      (message) => {
        setState("failed")
        setError(message)
      },
    )
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
        <p className="b4-approval__error">{approvalErrorLine(error)}</p>
      ) : null}
      {approval.offersAlways ? (
        <p className="b4-approval__scope">{scopeLine(approval.kind, approval.detail)}</p>
      ) : null}
    </section>
  )
}
