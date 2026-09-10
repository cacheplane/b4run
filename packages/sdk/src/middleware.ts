export interface MiddlewareRequest {
  readonly assistantId: string
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly params: Readonly<Record<string, string>>
  readonly routeId: string
  readonly url: string
}

export interface ContinueResult {
  readonly action: "continue"
  readonly context?: Record<string, unknown>
}

export interface RejectResult {
  readonly action: "reject"
  readonly body?: unknown
  readonly status: number
}

export type MiddlewareResult = ContinueResult | RejectResult

export type B4Middleware = (req: MiddlewareRequest) => Promise<MiddlewareResult> | MiddlewareResult

export function defineMiddleware(fn: B4Middleware): B4Middleware {
  return fn
}

export function reject(status: number, body?: unknown): RejectResult {
  if (body !== undefined) {
    return { action: "reject", body, status }
  }
  return { action: "reject", status }
}

export function allow(context?: Record<string, unknown>): ContinueResult {
  if (context) {
    return { action: "continue", context }
  }
  return { action: "continue" }
}
