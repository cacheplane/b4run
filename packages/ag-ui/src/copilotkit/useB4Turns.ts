import type { AbstractAgent } from "@ag-ui/client"
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { useCallback, useEffect, useRef, useState } from "react"
import { EMPTY_TURNS, type ReduceTurnsOptions, reduceTurns, type TurnsView } from "../view/turns.js"

export interface UseB4TurnsOptions {
  /**
   * The clock for events that carry no `timestamp` (live events); defaults to
   * `Date.now`. An event with a numeric `timestamp` (a restored thread's
   * replay) is folded at that time instead. Inject in tests.
   */
  readonly now?: (() => number) | undefined
  /** Tools whose frames the view drops entirely (`ReduceTurnsOptions.hiddenTools`). */
  readonly hiddenTools?: readonly string[] | undefined
}

export interface UseB4TurnsResult {
  readonly turns: TurnsView
  /**
   * Call right before sending a `resume`: the next `RUN_STARTED` then continues
   * the awaiting turn instead of guessing (`ReduceTurnsOptions.resuming`).
   */
  readonly markResuming: () => void
  /** Forget a `markResuming()` whose resume never went out (the request failed). */
  readonly clearResuming: () => void
}

/**
 * The agent's thread as turns, kept current from its event stream (replayed
 * events included — CopilotKit's `connect` replay reaches `agent.subscribe`
 * like a live run, and each replayed event's `timestamp` is its clock). Options are read through a ref so a new `hiddenTools`
 * array literal on every render never re-subscribes (which would reset the view).
 */
export function useB4Turns(
  agent: Pick<AbstractAgent, "subscribe"> | undefined,
  options: UseB4TurnsOptions = {},
): UseB4TurnsResult {
  const [turns, setTurns] = useState<TurnsView>(EMPTY_TURNS)
  const resuming = useRef(false)
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    if (agent === undefined) return
    setTurns(EMPTY_TURNS)
    const subscription = agent.subscribe({
      onEvent: ({ event }: { event: BaseEvent }) => {
        const { now, hiddenTools } = latest.current
        const isRunStart = event.type === EventType.RUN_STARTED
        // A replayed event is folded at the time it happened, not when it
        // arrived, so a restored turn keeps its real durations.
        const stamped = event.timestamp
        const clock =
          typeof stamped === "number" && Number.isFinite(stamped) ? () => stamped : now
        const reducerOptions: ReduceTurnsOptions = {
          ...(clock !== undefined ? { now: clock } : {}),
          ...(hiddenTools !== undefined ? { hiddenTools } : {}),
          ...(isRunStart && resuming.current ? { resuming: true } : {}),
        }
        if (isRunStart) resuming.current = false
        setTurns((previous) => reduceTurns(previous, event, reducerOptions))
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  const markResuming = useCallback(() => {
    resuming.current = true
  }, [])
  const clearResuming = useCallback(() => {
    resuming.current = false
  }, [])
  return { turns, markResuming, clearResuming }
}
