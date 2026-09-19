import type {
  SandboxHandle,
  SandboxPolicy,
  SandboxSecurityPolicy,
  SandboxWorkspaceReader,
} from "./sandbox-types.js"
import type { SourceBundle } from "./source-bundle.js"
import type { WorkspaceSourceDefinition } from "./source-capture.js"

export interface WorkspaceDefinition {
  readonly source: WorkspaceSourceDefinition
  readonly environmentLinks?: readonly { readonly path: string; readonly target: string }[]
  readonly baseline?: "git"
}
export interface CapturedWorkspaceDefinition {
  readonly version: 1
  readonly source: SourceBundle
  readonly environmentLinks: readonly { readonly path: string; readonly target: string }[]
  readonly baseline?: "git"
}
export interface WorkspaceEnvironment {
  readonly binding: { readonly provider: string; readonly scope: string; readonly account: string }
  readonly identity: string
}
export interface WorkspaceCreateIntent {
  readonly version: 1
  readonly operationId: string
  readonly installationId: string
  readonly threadId: string
  readonly sourceDigest: string
  readonly environment: WorkspaceEnvironment
  readonly environmentLinks: CapturedWorkspaceDefinition["environmentLinks"]
  readonly baseline?: "git"
  readonly digest: string
}
export interface WorkspaceReference {
  readonly version: 1
  readonly operationId: string
  readonly installationId: string
  readonly threadId: string
  readonly intentDigest: string
  /** Credential-free provider resource coordinates, never executable configuration. */
  readonly resource: Readonly<Record<string, string>>
}
export interface WorkspaceProvenance {
  readonly sourceDigest: string
  readonly environment: WorkspaceEnvironment
  readonly baselineCommit?: string
  readonly retention: {
    readonly filesystem: "until-destroy" | "expires"
    readonly expiresAt?: string
    readonly memory: "discarded" | "retained"
  }
}
export interface ReadyWorkspace {
  readonly reference: WorkspaceReference
  readonly provenance: WorkspaceProvenance
}
export interface WorkspaceSessionReference {
  readonly workspace: WorkspaceReference
  readonly incarnation: string
}
export interface WorkspaceSession {
  readonly reference: WorkspaceSessionReference
  readonly handle: SandboxHandle
}
export type CreationStatus =
  | { readonly status: "absent" | "pending" }
  | { readonly status: "ready"; readonly workspace: ReadyWorkspace }
  | {
      readonly status: "failed"
      readonly reason: { readonly code: WorkspaceLifecycleErrorCode; readonly message: string }
      readonly resourcesRemain: boolean
    }
  | { readonly status: "unknown"; readonly reason: string }
export interface WorkspaceDeletionTarget {
  readonly intent: WorkspaceCreateIntent
  readonly reference?: WorkspaceReference
}
/**
 * Addresses a managed workspace by its PUBLISHED record, never by a thread id:
 * the provider's storage is named by the intent (installation, operation,
 * binding), which no function of the thread id can reproduce.
 */
export interface OpenManagedWorkspaceReaderInput {
  readonly workspace: ReadyWorkspace
  readonly signal: AbortSignal
  /** Same vocabulary and default as `OpenWorkspaceReaderInput.runAsNonRoot`. */
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}
export interface ManagedWorkspaceProvider {
  readonly name: string
  resolveEnvironment(signal: AbortSignal): Promise<WorkspaceEnvironment>
  /** Small-source transport retains verified immutable exact bytes in a SourceBundle. */
  create(
    intent: WorkspaceCreateIntent,
    source: SourceBundle,
    signal: AbortSignal,
  ): Promise<ReadyWorkspace>
  inspectCreation(intent: WorkspaceCreateIntent, signal: AbortSignal): Promise<CreationStatus>
  reconnect(
    workspace: ReadyWorkspace,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<WorkspaceSession>
  release(session: WorkspaceSessionReference, signal: AbortSignal): Promise<void>
  destroy(target: WorkspaceDeletionTarget, signal: AbortSignal): Promise<void>
  /**
   * OPTIONAL capability with the contract of `SandboxProvider.openWorkspaceReader`:
   * a read-only view of the workspace's storage for a trusted, co-located host
   * process that never creates, starts, stops or replaces a session, makes
   * writes impossible, and rejects (never returns an empty view) when the
   * workspace is gone. Presence of the method is the capability probe. Not an
   * authorization boundary.
   */
  openWorkspaceReader?(input: OpenManagedWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
}
export type WorkspaceLifecycleErrorCode =
  | "lost"
  | "expired"
  | "conflict"
  | "unsupported"
  | "retryable"
  | "uncertain"
export class WorkspaceLifecycleError extends Error {
  constructor(
    readonly code: WorkspaceLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "WorkspaceLifecycleError"
  }
}
