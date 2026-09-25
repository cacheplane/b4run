import type { StagedWorkspaceReference, WorkspaceInspection } from "@b4run/workspace"

/**
 * What an app's `sandbox` block opens to HTTP callers. Pure: the runtime core
 * imports it, and `resolve-sandbox.ts` produces it.
 */
export interface WorkspaceProtocolSettings {
  /** `sandbox.workspaceRead: "http"`. */
  readonly read: boolean
  /** `sandbox.workspaceReadTimeoutMs`; the default when absent. */
  readonly readTimeoutMs?: number
  /** `sandbox.stagedWorkspaces`, resolved: present means uploads and `workspace` on create are served. */
  readonly staged?: StagedWorkspaceSettings
}

/** The content store's own payload cap: nothing larger could be kept anyway. */
export const STAGED_UPLOAD_MAX_BYTES = 96 * 1024 * 1024
export const STAGED_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000
export const STAGED_RETENTION_MIN_MS = 60 * 1000
export const STAGED_RETENTION_MAX_MS = 30 * 24 * 60 * 60 * 1000
export const STAGED_QUOTA_DEFAULT_BYTES = 1024 * 1024 * 1024
export const STAGED_QUOTA_MAX_BYTES = 16 * 1024 * 1024 * 1024
/** How long one upload body may take to arrive, so a trickling client cannot hold the only upload slot. */
export const STAGED_UPLOAD_TIMEOUT_DEFAULT_MS = 120_000
export const STAGED_UPLOAD_TIMEOUT_MIN_MS = 1_000
export const STAGED_UPLOAD_TIMEOUT_MAX_MS = 30 * 60_000
/**
 * Creates naming a staged workspace that run at once in one process. Each is cheap (the
 * reference is checked against the upload's recorded paths, never its bytes), but it holds
 * a store round-trip and two policy calls; past this a create is told to retry (429).
 */
export const STAGED_CREATES_MAX_IN_FLIGHT = 4

/** `sandbox.stagedWorkspaces` with its defaults applied. */
export interface StagedWorkspaceSettings {
  /** The largest upload body, in bytes. */
  readonly maxUploadBytes: number
  /** How long an unreferenced upload is kept before it may be reclaimed. */
  readonly retentionMs: number
  /** The stored bytes of every uploaded source together. */
  readonly maxStagedBytes: number
  /** How long one upload body may take to arrive. */
  readonly uploadTimeoutMs: number
}

/** `sandbox.stagedWorkspaces` as settings: `undefined` when off. Assumes the shape was checked. */
export function stagedWorkspaceSettings(value: unknown): StagedWorkspaceSettings | undefined {
  if (value === undefined || value === false) return undefined
  const limits =
    value === true
      ? {}
      : (value as {
          maxUploadBytes?: number
          retentionMs?: number
          maxStagedBytes?: number
          uploadTimeoutMs?: number
        })
  return Object.freeze({
    maxUploadBytes: limits.maxUploadBytes ?? STAGED_UPLOAD_MAX_BYTES,
    retentionMs: limits.retentionMs ?? STAGED_RETENTION_DEFAULT_MS,
    maxStagedBytes: limits.maxStagedBytes ?? STAGED_QUOTA_DEFAULT_BYTES,
    uploadTimeoutMs: limits.uploadTimeoutMs ?? STAGED_UPLOAD_TIMEOUT_DEFAULT_MS,
  })
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
  return [
    ...(block.workspaceRead !== undefined ? ["sandbox.workspaceRead"] : []),
    ...(block.stagedWorkspaces !== undefined && block.stagedWorkspaces !== false
      ? ["sandbox.stagedWorkspaces"]
      : []),
  ]
}

/** The same names, from resolved settings. */
export function openedWorkspaceProtocol(settings: WorkspaceProtocolSettings): string[] {
  return [
    ...(settings.read ? ["sandbox.workspaceRead"] : []),
    ...(settings.staged ? ["sandbox.stagedWorkspaces"] : []),
  ]
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

/** What an upload came to (`PUT /workspace/sources/:digest`). */
export type StageSourceOutcome =
  | { readonly ok: true; readonly status: "created" | "held" }
  | {
      readonly ok: false
      readonly code:
        | "digest_mismatch"
        | "workspace_source_invalid"
        | "staged_quota_exceeded"
        | "workspace_uploader_invalid"
      readonly message: string
    }

/** A create's `workspace`, checked against what this worker holds before any thread row exists. */
export type StagedWorkspaceCheck =
  | { readonly ok: true; readonly reference: StagedWorkspaceReference }
  | {
      readonly ok: false
      readonly code: "workspace_source_not_held" | "workspace_invalid"
      readonly message: string
    }

/** Recording a new thread's staged workspace, after its row exists. */
export type StagedWorkspaceAttach =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: "workspace_source_not_held" | "already_staged"
      readonly message: string
    }
