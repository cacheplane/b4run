/** A run observed an owned cooperative Stop after its active work settled. */
export class CooperativeStopError extends Error {
  constructor(reason = "Run stopped") {
    super(reason)
    this.name = "CooperativeStopError"
  }
}

export function isCooperativeStop(error: unknown): error is CooperativeStopError {
  return error instanceof CooperativeStopError
}
