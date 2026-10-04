import type { AbstractAgent } from "@ag-ui/client"
import { useEffect, useState } from "react"
import {
  EMPTY_SUBAGENT_RUNS,
  reduceSubagentRuns,
  type SubagentRunsState,
} from "../view/subagent-runs.js"

export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
} from "../view/subagent-runs.js"

/** The subset of `AbstractAgent` the hook needs: the subscription seam. */
export type SubagentEventSource = Pick<AbstractAgent, "subscribe">

/**
 * The subagent tree of the agent's current thread, kept current from its event
 * stream. Pass the `agent` CopilotKit's `useAgent()` returns (or any
 * `@ag-ui/client` agent); `undefined` while there is none.
 */
export function useSubagentRuns(agent: SubagentEventSource | undefined): SubagentRunsState {
  const [state, setState] = useState<SubagentRunsState>(EMPTY_SUBAGENT_RUNS)
  useEffect(() => {
    if (agent === undefined) return
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        setState((previous) => reduceSubagentRuns(previous, event))
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  return state
}
