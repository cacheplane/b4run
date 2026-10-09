"use client"
import { useAgent } from "@copilotkit/react-core/v2"
import { type Ref, useCallback, useEffect, useRef, useState } from "react"
import { Icon } from "./icons"
import { neutralButton, primaryButton } from "./ui"

/**
 * The memory candidates the agent has proposed, and the two decisions on them.
 *
 * `remember()` writes with `status: "candidate"` — nothing the agent proposes
 * becomes a real memory until a human says so. Without this panel that review
 * only exists in the `b4 memory` CLI, so the workbench could show the tool
 * call that proposed a memory and then nothing at all. This is the other half.
 *
 * Three endpoints, and they are the whole surface (see `lib/proxy-allowlist.ts`
 * — the proxy forwards these and nothing else):
 *
 * - `GET  /api/b4/memory/candidates`             -> `{ candidates }`
 * - `POST /api/b4/memory/candidates/:id/approve` -> `{ record, action, superseded }`
 * - `POST /api/b4/memory/candidates/:id/reject`  -> `{ ok: true }`
 *
 * Neither POST takes a body.
 */

/**
 * The fields of `MemoryRecord` (`packages/memory/src/types.ts`) this panel
 * reads, and only those.
 *
 * Deliberately a local, narrower type rather than the package's: this app
 * does not depend on `@b4run/memory` (the record arrives as JSON over the
 * proxy), and re-declaring the whole record here would be a second copy to
 * keep in sync for fields nothing renders.
 */
export interface MemoryCandidate {
  readonly id: string
  readonly content: string
  readonly namespace: string
  readonly tags?: readonly string[]
  readonly confidence?: number
}

/** What `POST …/approve` did, as the server reports it. */
export type ApproveAction = "activated" | "superseded" | "deduped"

/**
 * How long a transient outcome line stays on screen, in ms.
 *
 * It needs a timer at all because the row it describes is gone by the time it
 * appears: approving the only candidate empties the panel, and a message
 * anchored to a list that is now empty would otherwise sit there forever (or,
 * if the panel simply stopped rendering, be swallowed entirely — which is the
 * one outcome the plan is explicit about not swallowing). Long enough to read
 * a short sentence you were not looking for, short enough that the rail is
 * quiet again before you next glance at it.
 */
export const OUTCOME_LIFETIME_MS = 8000

/** Shown when a read fails for a reason that is not "the server is down". */
export const LOAD_FAILURE_NOTICE = "Couldn’t load memory candidates."

/** Shown when a decision does not land. The candidate is still there. */
export const DECISION_FAILURE_NOTICE = "Couldn’t save that decision — nothing changed."

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

/** "1 earlier memory" / "2 earlier memories". */
export function describeApprove(action: ApproveAction, supersededCount: number): string | null {
  if (action === "deduped") return "Already remembered — nothing changed."
  if (action !== "superseded" || supersededCount === 0) {
    // A plain activation says nothing: the row disappearing from the list
    // is the feedback, and a line confirming what the click obviously
    // did is the kind of noise that makes a panel easy to stop reading.
    return null
  }
  const noun = supersededCount === 1 ? "memory" : "memories"
  return `Replaced ${supersededCount} earlier ${noun}.`
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
          (isBusy ? "Saving…" : "Approving stores the memory. Deleting is permanent.")}
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
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="wb-row flex items-start gap-3 border border-wb-border bg-wb-surface px-2 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] leading-5">{candidate.content}</p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-wb-muted">
                  {[candidate.namespace, ...(candidate.tags ?? [])].join(" · ")}
                  {typeof candidate.confidence === "number"
                    ? ` · confidence ${candidate.confidence}`
                    : ""}
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
          ))}
        </ul>
      )}
    </section>
  )
}

/** The candidates out of a `GET /memory/candidates` body, defensively. */
function readCandidates(body: unknown): readonly MemoryCandidate[] {
  const list = (body as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is MemoryCandidate =>
      typeof (entry as MemoryCandidate | null)?.id === "string" &&
      typeof (entry as MemoryCandidate).content === "string",
  )
}

/** The proxy's owner-only refusal message (`{ error: "owner_only", message }`), defensively. */
function readOwnerOnlyMessage(body: unknown): string | null {
  const parsed = body as { error?: unknown; message?: unknown } | null
  return parsed?.error === "owner_only" && typeof parsed.message === "string"
    ? parsed.message
    : null
}

/** The approve outcome out of its response body, defensively. */
function readApproveOutcome(body: unknown): string | null {
  const parsed = body as { action?: unknown; superseded?: unknown } | null
  const action = parsed?.action
  if (action !== "activated" && action !== "superseded" && action !== "deduped") return null
  const superseded = Array.isArray(parsed?.superseded) ? parsed.superseded.length : 0
  return describeApprove(action, superseded)
}

/**
 * The fetching half.
 *
 * Reads on mount, after every decision, and at the end of every run — the last
 * one because `remember()` lands during a run, so a memory proposed in the
 * answer you are reading should be reviewable without a reload.
 * `onRunFinishedEvent` is a distinct `AgentSubscriber` callback in the
 * installed `@ag-ui/client@0.0.59`, and a finished run is the first moment the
 * write is certainly in the store.
 */
export interface MemoryPanelProps {
  /** Told the number of waiting candidates whenever it changes (the sidebar's count). */
  readonly onCountChange?: (count: number) => void
  /** Whether Memory mode is showing this panel. Opening focuses the heading. */
  readonly open?: boolean
  /** Closes Memory mode (the header's close button). */
  readonly onClose?: () => void
}

export function MemoryPanel({ onCountChange, open = false, onClose }: MemoryPanelProps = {}) {
  const { agent } = useAgent()
  const [candidates, setCandidates] = useState<readonly MemoryCandidate[]>([])

  useEffect(() => {
    onCountChange?.(candidates.length)
  }, [candidates.length, onCountChange])
  const [outcome, setOutcome] = useState<string | null>(null)
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])

  // Stale-response discipline, and an AbortController is not enough on its
  // own: the re-read after a decision is fired from a `.finally()` that owns
  // no signal, so an in-flight read has to be able to recognize that a newer
  // one has already started. Every read takes a ticket; only the latest ticket
  // may paint. The mounted flag is the second half, for a read that resolves
  // after this component is gone.
  const readTicketRef = useRef(0)
  // RE-ARMED on setup, not just cleared on cleanup. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup: a flag whose
  // only write is `= false` in the cleanup latches false forever on the second
  // setup. Every `isCurrent()` would then be permanently false and this panel
  // would render NOTHING in dev — candidates fetched, nothing painted, and
  // `isBusy` stuck on after the first decision. Verified in jsdom against a
  // non-Strict control.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    readTicketRef.current += 1
    const ticket = readTicketRef.current
    const isCurrent = () =>
      isMountedRef.current && readTicketRef.current === ticket && signal?.aborted !== true
    try {
      const response = await fetch("/api/b4/memory/candidates", signal ? { signal } : {})
      // 502 is the proxy's one dedicated "I cannot reach B4.run" signal (see
      // `route.ts`), and it belongs to another surface: the connect screen
      // owns this once a probe reports the server down, and while the
      // shell is up a run failure is the surface. Either way a second
      // "couldn't load" line in the panel would compete. See the error-surface
      // note at the top of `AppShell.tsx`.
      //
      // The list is left as it was — but the notice is CLEARED, because a
      // stale "couldn't load" from an earlier non-502 failure would otherwise
      // sit under a list this read just chose not to touch, saying the last
      // thing that went wrong rather than what is true now.
      if (response.status === 502) {
        if (isCurrent()) setLoadFailure(null)
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      if (!isCurrent()) return
      setCandidates(readCandidates(body))
      setLoadFailure(null)
    } catch {
      if (!isCurrent()) return
      // Quiet and muted, NOT a `RunError` row: nothing about the conversation
      // is broken, the rest of the app works, and a red alert in the panel for
      // a failed background read of a review queue is out of proportion to it.
      setLoadFailure(LOAD_FAILURE_NOTICE)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
    }
  }, [load])

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunFinishedEvent: () => {
        void load()
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent, load])

  // The outcome line is transient by construction: every new one restarts the
  // clock, and the timer is cleared on unmount so it cannot write into state
  // that is gone.
  useEffect(() => {
    if (outcome === null) return
    const id = setTimeout(() => {
      setOutcome(null)
    }, OUTCOME_LIFETIME_MS)
    return () => {
      clearTimeout(id)
    }
  }, [outcome])

  const decide = useCallback(
    (id: string, route: "approve" | "reject") => {
      setIsBusy(true)
      setOutcome(null)
      void fetch(`/api/b4/memory/candidates/${encodeURIComponent(id)}/${route}`, {
        method: "POST",
      })
        .then(async (response) => {
          if (response.status === 403) {
            // The deployed demo reserves approval for its owner, and the proxy
            // says so in its own words; anything else is a plain failure.
            const message = readOwnerOnlyMessage(await response.json().catch(() => null))
            if (message !== null) {
              if (isMountedRef.current) setOutcome(message)
              return
            }
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          // Reject's body is `{ ok: true }` and says nothing worth showing;
          // the row disappearing is the feedback, and the button already said
          // what it does.
          if (route !== "approve") return
          const body: unknown = await response.json()
          if (isMountedRef.current) setOutcome(readApproveOutcome(body))
        })
        .catch(() => {
          if (isMountedRef.current) setOutcome(DECISION_FAILURE_NOTICE)
        })
        // Re-read either way. On success the list has changed; on failure the
        // candidate is still there and the panel should say so by showing it.
        .finally(() => {
          void load().finally(() => {
            if (isMountedRef.current) setIsBusy(false)
          })
        })
    },
    [load],
  )

  const approve = useCallback(
    (id: string) => {
      decide(id, "approve")
    },
    [decide],
  )
  const reject = useCallback(
    (id: string) => {
      decide(id, "reject")
    },
    [decide],
  )

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
