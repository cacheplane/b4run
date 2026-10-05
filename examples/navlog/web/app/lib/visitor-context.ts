import { AsyncLocalStorage } from "node:async_hooks"

export interface VisitorContext {
  readonly visitorId: string
}

/**
 * Carries the visitor id from the CopilotKit route handler to the agent's
 * `fetch`. The agent is built once per process and shared by every request, so
 * the per-request id cannot be a constructor argument.
 */
export const visitorContext = new AsyncLocalStorage<VisitorContext>()
