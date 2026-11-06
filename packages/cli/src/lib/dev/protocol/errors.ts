import type { AspErrorCode, AspErrorResponse, B4ErrorResponse } from "@b4run/sdk/agent-protocol"
import { safeProtocolCatalogCode } from "../server-errors.js"

/** Public response policy from wire §11, separate from native error envelopes. */
const failures = {
  workspace_not_found: [404, "no_such_run", "Workspace not found"],
  workspace_lost: [404, "no_such_run", "Workspace unavailable"],
  workspace_expired: [410, "invalid_argument", "Workspace expired"],
  workspace_not_ready: [409, "invalid_argument", "Workspace not ready"],
  workspace_conflict: [409, "invalid_argument", "Workspace conflict"],
  workspace_changed: [409, "invalid_argument", "Workspace changed"],
  workspace_unavailable: [503, "unknown_error", "Workspace unavailable"],
  workspace_root_missing: [422, "invalid_argument", "Workspace root missing"],
  workspace_inspection_refused: [422, "invalid_argument", "Workspace inspection refused"],
  workspace_read_timeout: [504, "unknown_error", "Workspace read timed out"],
  workspace_response_too_large: [422, "invalid_argument", "Workspace response too large"],
  invalid_request: [400, "invalid_argument", "Invalid request"],
  digest_mismatch: [400, "invalid_argument", "Source digest mismatch"],
  workspace_source_invalid: [422, "invalid_argument", "Invalid workspace source"],
  staged_quota_exceeded: [507, "unknown_error", "Staging quota exceeded"],
  workspace_uploader_invalid: [422, "invalid_argument", "Invalid workspace uploader"],
  upload_timeout: [408, "invalid_argument", "Upload timed out"],
  malformed_json: [400, "invalid_argument", "Malformed JSON"],
  invalid_argument: [422, "invalid_argument", "Invalid request"],
  auth_required: [401, "permission_denied", "Authentication required"],
  not_found: [404, "no_such_run", "Resource not found"],
  thread_exists: [409, "invalid_argument", "Thread already exists"],
  thread_busy: [409, "invalid_argument", "Thread is busy"],
  stale_generation: [409, "invalid_argument", "Generation changed"],
  incomplete_responses: [422, "invalid_argument", "Incomplete or duplicate responses"],
  grant_invalid: [403, "permission_denied", "Invalid grant"],
  grant_expired: [403, "permission_denied", "Grant expired"],
  approval_changed: [409, "invalid_argument", "Approval changed"],
  not_supported: [422, "not_supported", "Feature not supported"],
  resync_required: [409, "invalid_argument", "Resynchronization required"],
  history_changed: [409, "invalid_argument", "History changed"],
  history_expired: [410, "invalid_argument", "History expired"],
  result_expired: [410, "invalid_argument", "Result expired"],
  submission_conflict: [409, "invalid_argument", "Submission conflicts with an earlier request"],
  receipt_expired: [409, "invalid_argument", "Receipt expired"],
  capacity_exceeded: [429, "invalid_argument", "Capacity exceeded"],
  storage_unavailable: [503, "unknown_error", "Storage unavailable"],
  submission_ambiguous: [409, "invalid_argument", "Submission requires target selectors"],
  submission_target_gone: [409, "invalid_argument", "Submission target unavailable"],
  submission_already_accepted: [409, "invalid_argument", "Submission already accepted"],
  agent_required: [422, "invalid_argument", "Agent selection required"],
  item_changed: [409, "invalid_argument", "Item changed"],
  precondition_failed: [412, "invalid_argument", "Precondition failed"],
  body_too_large: [413, "invalid_argument", "Request body too large"],
  durable_capacity_exceeded: [507, "unknown_error", "Durable capacity exceeded"],
  unknown_command: [422, "unknown_command", "Unknown command"],
  internal_error: [500, "unknown_error", "Internal server error"],
} as const satisfies Record<string, readonly [number, AspErrorCode, string]>
export type ProtocolErrorCode = keyof typeof failures
export interface ProtocolErrorOptions {
  readonly resource?: "thread" | "run" | "checkpoint" | "input" | "namespace"
  readonly retryAfter?: number
  /** A trusted capability name, never a request value or protected target. */
  readonly feature?:
    | "rollback"
    | "injection"
    | "systemInjection"
    | "stateEdit"
    | "copy"
    | "fork"
    | "update"
    | "goto"
    | "config"
}

const publicFeatures = new Set<unknown>([
  "rollback",
  "injection",
  "systemInjection",
  "stateEdit",
  "copy",
  "fork",
  "update",
  "goto",
  "config",
])

/** Only explicitly constructed public failures can carry protocol diagnostics.
 * Runtime exceptions and arbitrary objects are never serialized verbatim. */
export class ProtocolError extends Error {
  readonly options: ProtocolErrorOptions
  constructor(
    readonly code: ProtocolErrorCode,
    options: ProtocolErrorOptions = {},
  ) {
    super(failures[code][2])
    this.name = "ProtocolError"
    this.options = Object.freeze({
      ...(options.resource !== undefined ? { resource: options.resource } : {}),
      ...(options.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {}),
      ...(options.feature !== undefined && publicFeatures.has(options.feature)
        ? { feature: options.feature }
        : {}),
    })
  }
  get status(): number {
    return failures[this.code][0]
  }
}
function normalized(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error
  const catalog = safeProtocolCatalogCode(error)
  return new ProtocolError(catalog ?? "internal_error")
}
export function protocolRestError(error: unknown): B4ErrorResponse {
  const failure = normalized(error)
  return {
    code: failure.code,
    message: failures[failure.code][2],
    ...(failure.options.feature
      ? { metadata: { b4: { v: 1, code: failure.code, feature: failure.options.feature } } }
      : {}),
  }
}
export function protocolAspError(error: unknown, id: number | null): AspErrorResponse {
  const failure = normalized(error)
  let code: AspErrorCode = failures[failure.code][1]
  if (failure.code === "not_found") {
    const resource = failure.options.resource
    if (resource === "checkpoint") code = "no_such_checkpoint"
    if (resource === "input") code = "no_such_interrupt"
    if (resource === "namespace") code = "no_such_namespace"
    if (resource === "thread") code = "permission_denied"
  }
  if (failure.code === "stale_generation" && failure.options.resource === "input")
    code = "no_such_interrupt"
  return {
    type: "error",
    id,
    error: code,
    message: failures[failure.code][2],
    meta: {
      b4: {
        v: 1,
        code: failure.code,
        ...(failure.options.feature ? { feature: failure.options.feature } : {}),
      },
    },
  }
}
export function protocolErrorResponse(error: unknown): Response {
  const failure = normalized(error)
  const retry = failure.options.retryAfter
  return Response.json(protocolRestError(failure), {
    status: failure.status,
    ...(failure.code === "capacity_exceeded"
      ? {
          headers: {
            "Retry-After": String(Number.isSafeInteger(retry) && (retry ?? 0) > 0 ? retry : 1),
          },
        }
      : {}),
  })
}
