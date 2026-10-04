import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { useCallback, useEffect, useRef, useState } from "react"
import type { SubagentEventSource } from "../react/useSubagentRuns.js"
import { EMPTY_TURNS, type ReduceTurnsOptions, reduceTurns, type TurnsView } from "../view/turns.js"

export interface UseB4TurnsOptions {
  /** The clock; defaults to `Date.now`. Inject in tests. */
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
 * like a live run). Options are read through a ref so a new `hiddenTools`
 * array literal on every render never re-subscribes (which would reset the view).
 */
export function useB4Turns(
  agent: SubagentEventSource | undefined,
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
        const reducerOptions: ReduceTurnsOptions = {
          ...(now !== undefined ? { now } : {}),
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
