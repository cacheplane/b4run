"use client"
import { useAgent } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type MemoryCandidate,
  readApproveOutcome,
  readCandidates,
  readOwnerOnlyMessage,
} from "./memory-candidates"

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

export interface MemoryCandidatesState {
  readonly candidates: readonly MemoryCandidate[]
  /** True while a decision and its re-read are in flight. */
  readonly isBusy: boolean
  /** The transient outcome of the last decision, cleared after `OUTCOME_LIFETIME_MS`. */
  readonly outcome: string | null
  /** A sticky notice for a read that failed. Cleared by the next success. */
  readonly loadFailure: string | null
  readonly approve: (id: string) => void
  readonly reject: (id: string) => void
}

/**
 * The memory review queue: the candidates, and the two decisions on them.
 *
 * Reads on mount, after every decision, and at the end of every run — the last
 * one because `remember()` lands during a run, so a memory proposed in the
 * answer you are reading should be reviewable without a reload.
 * `onRunFinishedEvent` is a distinct `AgentSubscriber` callback in the
 * installed `@ag-ui/client@0.0.59`, and a finished run is the first moment the
 * write is certainly in the store.
 */
export function useMemoryCandidates(): MemoryCandidatesState {
  const { agent } = useAgent()
  const [candidates, setCandidates] = useState<readonly MemoryCandidate[]>([])
  const [outcome, setOutcome] = useState<string | null>(null)
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // Stale-response discipline, and an AbortController is not enough on its
  // own: the re-read after a decision is fired from a `.finally()` that owns
  // no signal, so an in-flight read has to be able to recognize that a newer
  // one has already started. Every read takes a ticket; only the latest ticket
  // may paint. The mounted flag is the second half, for a read that resolves
  // after the panel is gone.
  const readTicketRef = useRef(0)
  // RE-ARMED on setup, not just cleared on cleanup. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup: a flag whose
  // only write is `= false` in the cleanup latches false forever on the second
  // setup. Every `isCurrent()` would then be permanently false and the panel
  // would render NOTHING in dev — candidates fetched, nothing painted, and
  // `isBusy` stuck on after the first decision.
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

  // Keyed on the agent instance, so an agent swap (the provisional stand-in
  // replaced by the runtime's agent after `/info`) re-subscribes the new one.
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

  const approve = useCallback((id: string) => decide(id, "approve"), [decide])
  const reject = useCallback((id: string) => decide(id, "reject"), [decide])

  return { candidates, isBusy, outcome, loadFailure, approve, reject }
}
