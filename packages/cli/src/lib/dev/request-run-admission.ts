import type { RequestRunAdmission } from "@b4run/sdk"
import { createRequestErrorBody } from "./server-errors.js"

interface Binding {
  readonly admission: RequestRunAdmission
  release?: Promise<void>
}

const bindings = new WeakMap<Request, Binding>()

/** Bind request-owned shared coordination without introducing process-global ownership. */
export function bindRequestRunAdmission(
  request: Request,
  admission: RequestRunAdmission | undefined,
): void {
  if (admission) bindings.set(request, { admission })
}

/** The optional shared owner whose signal must stop this request's execution. */
export function requestRunAdmission(request: Request): RequestRunAdmission | undefined {
  return bindings.get(request)?.admission
}

/** Authorize before calling: a shared conflict must not reveal another visitor's activity. */
export async function claimRequestRun(
  request: Request,
  threadId: string,
): Promise<Response | undefined> {
  const binding = bindings.get(request)
  if (!binding) return undefined
  if (await binding.admission.tryAcquire(threadId)) return undefined
  return Response.json(
    createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
      code: "run_in_flight",
    }),
    { status: 409, headers: { "retry-after": "1" } },
  )
}

/** One asynchronous finalizer shared by terminal framing, detached cleanup and disposal. */
export function releaseRequestRun(request: Request): Promise<void> {
  const binding = bindings.get(request)
  if (!binding) return Promise.resolve()
  binding.release ??= Promise.resolve().then(() => binding.admission.release())
  return binding.release
}

/** Remove request-bound coordination after its body and actual execution have settled. */
export function forgetRequestRunAdmission(request: Request): void {
  bindings.delete(request)
}
