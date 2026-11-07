import type { PermissionsStore } from "./types.js"

/** Server-selected rule in the store's existing configured scope. */
export interface PermissionRule {
  readonly tool: string
  readonly pattern: string
}
/** Private runtime intent payload; never permission authority or caller config. */
export interface RememberedRuleIntent {
  readonly operationId: string
  readonly scopeId: string
  readonly revision: string
  readonly rules: readonly PermissionRule[]
}
export interface RememberedRuleCoordinator {
  prepare(operationId: string, rules: readonly PermissionRule[]): Promise<RememberedRuleIntent>
  /** Rule mutation and operation receipt must commit together in this domain.
   * A later explicit rule edit fences an older unapplied intent. */
  apply(intent: RememberedRuleIntent): Promise<"applied" | "superseded">
}

/** Existing gate vocabulary, shared with atomic permission acceptance. The
 * request comes from the server's protected parked proposal, never responses. */
export function permissionRuleForRequest(
  request: Readonly<Record<string, unknown>>,
): PermissionRule {
  const detail = request.detail as Record<string, unknown> | undefined
  const tool =
    request.kind === "command" ? "bash" : request.kind === "path" ? detail?.operation : request.kind
  if (
    !detail ||
    typeof tool !== "string" ||
    !["bash", "readFile", "writeFile", "listDir", "tool", "subagent", "memory"].includes(tool) ||
    typeof detail.suggestedPattern !== "string"
  )
    throw new Error("Invalid protected permission rule")
  return { tool, pattern: detail.suggestedPattern }
}

/** The coordinator never converts a remembered receipt into current authority. */
export function ruleDenied(store: PermissionsStore, rules: readonly PermissionRule[]): boolean {
  return rules.some((rule) => store.match(rule.tool, rule.pattern) === "deny")
}

/** Existing candidate vocabulary; display previews never grant authority. */
export function permissionCandidateForRequest(request: Readonly<Record<string, unknown>>): string {
  const detail = request.detail as Record<string, unknown> | undefined
  const candidate =
    request.kind === "command"
      ? detail?.command
      : request.kind === "path"
        ? detail?.path
        : request.kind === "tool"
          ? detail?.toolName
          : request.kind === "memory" && typeof detail?.namespace === "string"
            ? `${detail.namespace}|`
            : detail?.suggestedPattern
  if (typeof candidate !== "string") throw new Error("Invalid protected permission candidate")
  return candidate
}
