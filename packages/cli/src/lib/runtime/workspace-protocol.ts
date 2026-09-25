import type { WorkspaceInspection } from "@b4run/workspace"

/**
 * What an app's `sandbox` block opens to HTTP callers. Pure: the runtime core
 * imports it, and `resolve-sandbox.ts` produces it.
 */
export interface WorkspaceProtocolSettings {
  /** `sandbox.workspaceRead: "http"`. */
  readonly read: boolean
  /** `sandbox.workspaceReadTimeoutMs`; the default when absent. */
  readonly readTimeoutMs?: number
}

/**
 * How long one workspace read may take, open to close, before it is abandoned with
 * `workspace_read_timeout`: a provider that never answers must not hold the thread's
 * run slot forever. `sandbox.workspaceReadTimeoutMs` sets it.
 */
export const WORKSPACE_READ_TIMEOUT_DEFAULT_MS = 120_000
export const WORKSPACE_READ_TIMEOUT_MIN_MS = 1_000
export const WORKSPACE_READ_TIMEOUT_MAX_MS = 30 * 60_000

export const NO_WORKSPACE_PROTOCOL: WorkspaceProtocolSettings = Object.freeze({ read: false })

/** The options a `sandbox` block sets that open a thread's workspace, as the config spells them. */
export function workspaceProtocolOptionNames(sandbox: unknown): string[] {
  if (sandbox === null || typeof sandbox !== "object") return []
  const block = sandbox as Record<string, unknown>
  return block.workspaceRead !== undefined ? ["sandbox.workspaceRead"] : []
}

/** The same names, from resolved settings. */
export function openedWorkspaceProtocol(settings: WorkspaceProtocolSettings): string[] {
  return settings.read ? ["sandbox.workspaceRead"] : []
}

export function workspaceProtocolPolicyMessage(names: readonly string[]): string {
  const subject = names.join(" and ")
  return (
    `${subject} ${names.length === 1 ? "serves" : "serve"} a thread's workspace over HTTP, and this app has ` +
    "no thread-access policy, so anyone who can reach the port could use it. Add src/thread-access.ts " +
    "(see the thread access docs) or remove the option."
  )
}

/** A validated `POST /threads/:thread_id/workspace/inspect` body. */
export interface ThreadWorkspaceInspectRequest {
  readonly root?: string
  readonly excludeRootDirectories: readonly string[]
  readonly expectedRootSymlinks: Readonly<Record<string, string>>
  readonly ignorePrefixes: readonly string[]
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export type ThreadWorkspaceInspectFailure =
  | "workspace_not_found"
  | "workspace_lost"
  | "workspace_expired"
  | "workspace_not_ready"
  | "workspace_conflict"
  | "workspace_unavailable"
  | "workspace_root_missing"
  | "workspace_changed"
  | "workspace_inspection_refused"
  | "workspace_read_timeout"
  | "invalid_request"

export type ThreadWorkspaceInspectOutcome =
  | {
      readonly ok: true
      readonly sourceDigest: string
      readonly intentDigest: string
      readonly inspection: WorkspaceInspection
    }
  | {
      readonly ok: false
      readonly code: ThreadWorkspaceInspectFailure
      readonly message: string
      readonly root?: string
      readonly kind?: "absent" | "not_directory"
    }
