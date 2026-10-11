"use client"
import { type Ref, useEffect, useRef } from "react"
import { neutralButton, primaryButton } from "../lib/buttons"
import type { MemoryCandidate } from "../lib/memory-candidates"
import { useMemoryCandidates } from "../lib/use-memory-candidates"
import { Icon } from "./icons"

/**
 * The memory candidates the agent has proposed, and the two decisions on them.
 *
 * `remember()` writes with `status: "candidate"` — nothing the agent proposes
 * becomes a real memory until a human says so. Without this panel that review
 * only exists in the `b4 memory` CLI, so the workbench could show the tool
 * call that proposed a memory and then nothing at all. This is the other half.
 *
 * Split in three: the endpoint bodies and their readers are data
 * (`lib/memory-candidates.ts`), the fetching and the decisions are a hook
 * (`lib/use-memory-candidates.ts`), and this file is the view plus the thin
 * container that joins them.
 */

export interface MemoryPanelViewProps {
  readonly candidates: readonly MemoryCandidate[]
  readonly onApprove: (id: string) => void
  readonly onReject: (id: string) => void
  /**
   * True while a decision is in flight. Disables BOTH actions on EVERY row,
   * not just the row that was clicked: a decision is followed by a re-read of
   * the whole list, so a second click during that window is acting on a list
   * that is already known to be stale.
   */
  readonly isBusy: boolean
  /** The transient outcome of the last decision, if it was worth reporting. */
  readonly outcome: string | null
  /** A sticky quiet line for a read that failed. Cleared by the next success. */
  readonly loadFailure: string | null
  /** Shown as the header's close button (Memory mode). */
  readonly onClose?: () => void
  /** The heading, focused when Memory mode opens. */
  readonly headingRef?: Ref<HTMLHeadingElement>
}

/**
 * A candidate's content, short enough to sit inside a control's name.
 *
 * Truncated because an accessible name is read out in full: a two-sentence
 * memory turns "Approve" into a paragraph, and the distinguishing part is at
 * the front. The ellipsis is the character, not three dots, so a screen
 * reader does not say "dot dot dot".
 */
const LABEL_LIMIT = 60

function shortLabel(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim()
  return collapsed.length <= LABEL_LIMIT ? collapsed : `${collapsed.slice(0, LABEL_LIMIT - 1)}…`
}

/**
 * The panel, as pure props.
 *
 * Split out from the container for the reason every other component in this
 * app is: the branching (empty, populated, busy, failed) is
 * assertable with `renderToStaticMarkup` and nothing else has to exist for it.
 */
export function MemoryPanelView({
  candidates,
  onApprove,
  onReject,
  isBusy,
  outcome,
  loadFailure,
  onClose,
  headingRef,
}: MemoryPanelViewProps) {
  return (
    <section
      aria-label="Memory candidates"
      aria-busy={isBusy}
      className="wb-panel flex h-full min-h-0 flex-col"
    >
      <header className="wb-header-row gap-2 border-b border-wb-border pl-4 pr-2">
        {/* Focused on open (tabIndex -1: a target, not a tab stop). */}
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 text-[14px] font-semibold leading-5 tracking-tight focus:outline-none"
        >
          Memory
          <span className="ml-1.5 font-mono font-normal text-wb-muted">· {candidates.length}</span>
        </h2>
        {onClose ? (
          <button
            type="button"
            aria-label="Close memory"
            onClick={onClose}
            className="wb-focus wb-icon-button wb-icon-button-quiet"
          >
            <Icon name="close" />
          </button>
        ) : null}
      </header>
      {/*
        A live region that is always present, with its text swapped: screen
        readers announce a change to a region already in the tree far more
        reliably than an inserted one. Polite (`role="status"`): it must not
        interrupt.
      */}
      <p role="status" className="px-4 pt-3 text-[12px] leading-4 text-wb-muted">
        {outcome ??
          loadFailure ??
          (isBusy
            ? "Saving…"
            : // The hint is about the buttons; with no candidates it says nothing.
              candidates.length > 0
              ? "Approving stores the memory. Deleting is permanent."
              : null)}
      </p>
      {candidates.length === 0 ? (
        <div className="px-4 pt-6">
          <p className="text-[13px] font-medium">Nothing waiting for review.</p>
          <p className="mt-1 text-[12px] leading-5 text-wb-muted">
            When the planner proposes something to remember, it appears here for you to approve or
            delete.
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-3">
          {candidates.map((candidate) => {
            const metadata =
              [candidate.namespace, ...(candidate.tags ?? [])].join(" · ") +
              (typeof candidate.confidence === "number"
                ? ` · confidence ${candidate.confidence}`
                : "")
            return (
              <li
                key={candidate.id}
                className="wb-row flex items-start gap-3 border border-wb-border bg-wb-surface px-2 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13px] leading-5">{candidate.content}</p>
                  <p
                    title={metadata}
                    className="mt-0.5 truncate font-mono text-[12px] text-wb-muted"
                  >
                    {metadata}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {/*
                  `aria-label` carries which candidate a button acts on: rows
                  of identical "Approve" buttons are otherwise
                  indistinguishable to anyone navigating by control.
                */}
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-label={`Approve: ${shortLabel(candidate.content)}`}
                    onClick={() => onApprove(candidate.id)}
                    className={`${primaryButton("sm")} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-4`}
                  >
                    Approve
                  </button>
                  {/*
                  "Delete", not "Reject": the endpoint is `…/reject`, but it
                  hard-deletes the candidate. Naming the button after the
                  effect is the warning.
                */}
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-label={`Delete permanently: ${shortLabel(candidate.content)}`}
                    onClick={() => onReject(candidate.id)}
                    className={`${neutralButton("sm")} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-4`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export interface MemoryPanelProps {
  /** Told the number of waiting candidates whenever it changes (the sidebar's count). */
  readonly onCountChange?: (count: number) => void
  /** Whether Memory mode is showing this panel. Opening focuses the heading. */
  readonly open?: boolean
  /** Closes Memory mode (the header's close button). */
  readonly onClose?: () => void
}

/** Memory mode's review: the memories the agent proposed, each to approve or reject. */
export function MemoryPanel({ onCountChange, open = false, onClose }: MemoryPanelProps = {}) {
  const { candidates, isBusy, outcome, loadFailure, approve, reject } = useMemoryCandidates()

  useEffect(() => {
    onCountChange?.(candidates.length)
  }, [candidates.length, onCountChange])

  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])

  return (
    <MemoryPanelView
      candidates={candidates}
      onApprove={approve}
      onReject={reject}
      isBusy={isBusy}
      outcome={outcome}
      loadFailure={loadFailure}
      headingRef={heading}
      {...(onClose ? { onClose } : {})}
    />
  )
}
