import type { ReceiptResponseMetaV1, ResyncRequiredV1 } from "./metadata.js"

/** Closed CDDL ErrorCode. B4 diagnostics belong in meta.b4, never this enum. */
export const ASP_ERROR_CODES = [
  "invalid_argument",
  "unknown_command",
  "unknown_error",
  "no_such_run",
  "no_such_subscription",
  "no_such_namespace",
  "no_such_interrupt",
  "no_such_checkpoint",
  "permission_denied",
  "not_supported",
] as const
/** Known B4 REST diagnostics; retained workspace/Store domain codes remain valid. */
export const B4_ERROR_CODES = [
  "malformed_json",
  "invalid_argument",
  "auth_required",
  "permission_denied",
  "not_found",
  "thread_exists",
  "thread_busy",
  "stale_generation",
  "incomplete_responses",
  "grant_invalid",
  "grant_expired",
  "approval_changed",
  "not_supported",
  "resync_required",
  "history_changed",
  "history_expired",
  "result_expired",
  "submission_conflict",
  "receipt_expired",
  "capacity_exceeded",
  "storage_unavailable",
  "submission_ambiguous",
  "submission_target_gone",
  "submission_already_accepted",
  "agent_required",
  "item_changed",
] as const
export type B4ErrorCode = (typeof B4_ERROR_CODES)[number]
export interface B4DiagnosticV1 {
  readonly v: 1
  readonly code: string
  readonly [key: string]: unknown
}
export interface B4ErrorResponse {
  readonly code: string
  readonly message: string
  readonly metadata?: Readonly<Record<string, unknown>> & {
    readonly b4?: B4DiagnosticV1 | ReceiptResponseMetaV1 | ResyncRequiredV1
  }
}
