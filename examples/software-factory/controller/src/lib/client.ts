import { randomUUID } from "node:crypto"
import type { RouteOutcome } from "./routes/outcome.js"

export class ControllerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "ControllerHttpError"
  }
}

/** The controller's routes over the Agent Protocol. One thread per work order; `create` runs on a key-derived thread. */
export function createControllerClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "")
  async function run(
    threadId: string,
    route: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    const response = await fetchImpl(`${base}/threads/${encodeURIComponent(threadId)}/runs/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route, input }),
      ...(signal ? { signal } : {}),
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      // The runtime reports its refusal code under `error.details.code`, not at the top of
      // the error: `run_in_flight` for a second command on a busy work order and
      // `run_cancelled` for a dispatch whose thread was cancelled.
      const failed = body as { error?: { message?: string; details?: { code?: string } } }
      throw new ControllerHttpError(
        response.status,
        failed.error?.details?.code,
        failed.error?.message ?? `HTTP ${response.status}`,
      )
    }
    return body as RouteOutcome
  }
  const withKey = (id: string, operationKey?: string) => ({
    id,
    ...(operationKey ? { operationKey } : {}),
  })
  return {
    create: (input: { taskId: string; operationKey?: string }) =>
      run(`create:${input.operationKey ?? randomUUID()}`, "/work-orders/create#workflow", input),
    dispatch: (id: string, operationKey?: string, signal?: AbortSignal) =>
      run(id, "/work-orders/dispatch#workflow", withKey(id, operationKey), signal),
    approve: (
      id: string,
      input: { revision: number; bundleDigest: string; operationKey?: string },
    ) => run(id, "/work-orders/approve#workflow", { id, ...input }),
    deny: (id: string, operationKey?: string) =>
      run(id, "/work-orders/deny#workflow", withKey(id, operationKey)),
    cancel: (id: string, operationKey?: string) =>
      run(id, "/work-orders/cancel#workflow", withKey(id, operationKey)),
    reconcile: () => run("controller", "/reconcile#workflow", {}),
    /** The runtime's cancel of the work order's in-flight run, for a dispatch that is still awaiting. */
    async interrupt(id: string): Promise<"interrupted" | "no_run_in_flight"> {
      const response = await fetchImpl(`${base}/threads/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      })
      if (response.ok) return "interrupted"
      const body: unknown = await response.json().catch(() => ({}))
      const failed = body as { error?: { message?: string; details?: { code?: string } } }
      // Only "there was nothing to cancel" is an answer; anything else (the thread is
      // unknown to this controller, the controller is broken, a proxy answered) is a failure
      // the caller must see rather than mistake for an idle work order.
      if (response.status === 404 || response.status === 409) return "no_run_in_flight"
      throw new ControllerHttpError(
        response.status,
        failed.error?.details?.code,
        failed.error?.message ?? `HTTP ${response.status}`,
      )
    },
  }
}
export type ControllerClient = ReturnType<typeof createControllerClient>
