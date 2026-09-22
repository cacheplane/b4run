/**
 * The three refusal classes the controller throws and the route layer turns into outcome
 * values. They live in the domain, not next to the Factory: a reader that never builds a
 * Factory (the CLI's registry reader) must be able to name them without importing the
 * controller — and with it the exporter, the verifier and everything else the Factory needs.
 */
export class CommandInFlightError extends Error {
  constructor(readonly operationKey: string) {
    super(`Command ${operationKey} is still in flight; restart the factory to reconcile it`)
    this.name = "CommandInFlightError"
  }
}

export class UnknownTaskError extends Error {
  constructor(taskId: string) {
    super(`Unknown task ${taskId}`)
    this.name = "UnknownTaskError"
  }
}

export class UnknownWorkOrderError extends Error {
  constructor(id: string) {
    super(`Unknown work order ${id}`)
    this.name = "UnknownWorkOrderError"
  }
}
