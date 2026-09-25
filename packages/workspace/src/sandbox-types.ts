/**
 * Execution-sandbox contract. A SandboxProvider yields, per conversation
 * thread, a SandboxHandle whose filesystem/exec backends implement the same
 * interfaces the workspace capability already consumes — so swapping them in
 * redirects all of readFile/writeFile/editFile/listDir/runBash into the isolated env
 * with no change to the capability. See the execution-sandbox spec.
 */
import type {
  CapturedWorkspaceDefinition,
  ManagedWorkspaceProvider,
  WorkspaceDefinition,
} from "./managed-workspace.js"
import type { ExecBackend, FilesystemBackend } from "./types.js"

export interface SandboxPolicy {
  readonly network:
    | { readonly mode: "allow"; readonly denylist?: readonly string[] }
    | { readonly mode: "deny"; readonly allowlist?: readonly string[] }
  /** Explicit env injected into the sandbox. The host env is NEVER inherited. */
  readonly env?: Readonly<Record<string, string>>
  readonly resources?: {
    readonly memoryMb?: number
    readonly cpus?: number
    readonly timeoutMs?: number
    /** Per-thread workspace volume size in GiB (PVC providers, e.g. Kubernetes). Docker ignores it. */
    readonly diskGb?: number
  }
  readonly security?: SandboxSecurityPolicy
}

/**
 * Provider-agnostic hardening intent. Each provider translates these to its own
 * mechanism; a field left unset means the provider applies its SECURE default
 * (all of these default ON/hardened at the Docker provider). Authors relax
 * explicitly. See the sandbox-hardening spec.
 */
export interface SandboxSecurityPolicy {
  /** Drop all Linux capabilities. Secure default: true. */
  readonly dropAllCapabilities?: boolean
  /** Block setuid/setgid privilege escalation. Secure default: true. */
  readonly noNewPrivileges?: boolean
  /** Immutable root filesystem (workspace + scratch stay writable). Secure default: true. */
  readonly readOnlyRootFilesystem?: boolean
  /** Run as non-root. Secure default: true → uid/gid 1000:1000. `false` = image default (often root). */
  readonly runAsNonRoot?: boolean | { readonly uid: number; readonly gid: number }
  /** Max process count (fork-bomb defense). Secure default: 512. */
  readonly pidsLimit?: number
}

export interface SandboxHandle {
  readonly threadId: string
  readonly filesystem: FilesystemBackend
  readonly exec: ExecBackend
  /** Absolute path of the workspace root INSIDE the sandbox, e.g. "/workspace". */
  readonly workspaceRoot: string
}

/**
 * The read-only projection of a workspace filesystem. `lstat`, `readBinaryFile`
 * and `statFile` are REQUIRED here, unlike on `FilesystemBackend`: a surface
 * built for inspection has no reason to omit the metadata inspection needs, so
 * `inspectWorkspace` can never fail against one for a missing capability.
 */
export type ReadOnlyFilesystemBackend = Readonly<
  Pick<
    Required<FilesystemBackend>,
    "lstat" | "readFile" | "readBinaryFile" | "listDir" | "statFile"
  > &
    Pick<FilesystemBackend, "walkTree" | "readBinaryFiles">
>

/**
 * The minimum a workspace inspector consumes. `SandboxHandle` satisfies it, and
 * so does a read-only reader that has no `exec` backend at all.
 */
export interface WorkspaceReadSource {
  readonly filesystem: Pick<
    FilesystemBackend,
    "lstat" | "readBinaryFile" | "listDir" | "walkTree" | "readBinaryFiles"
  >
  /** Absolute path of the workspace root INSIDE the sandbox, e.g. "/workspace". */
  readonly workspaceRoot: string
}

export interface OpenWorkspaceReaderInput {
  readonly threadId: string
  readonly signal: AbortSignal
  /**
   * Identity the reader runs as, in the same vocabulary as
   * `SandboxSecurityPolicy.runAsNonRoot`. Defaults to the provider's secure
   * default (uid/gid 1000:1000 on Docker), which is the owner of a workspace
   * produced under the default policy. Mirror the thread's own policy when it
   * relaxed that default, or restrictive modes on root-owned files are
   * unreadable.
   */
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}

/**
 * A read-only view of one thread's workspace storage, independent of that
 * thread's live sandbox. Carries no `exec` backend and no write operations:
 * there is no API here through which a caller can express a mutation.
 *
 * Close it. `withWorkspaceReader` does that for you.
 */
export interface SandboxWorkspaceReader extends WorkspaceReadSource {
  readonly threadId: string
  readonly filesystem: ReadOnlyFilesystemBackend
  /** Release reader-side resources. Idempotent. Never touches the thread's sandbox. */
  close(): Promise<void>
}

export interface SandboxProvider {
  readonly workspaces?: ManagedWorkspaceProvider
  readonly name: string
  /**
   * Create-or-reattach the thread's sandbox. Idempotent per threadId: called at
   * the start of every turn; returns the same live sandbox across turns until
   * release()/destroy(). Reattaches an existing workspace volume by deterministic
   * name after a restart or container reap rather than starting empty.
   */
  acquire(input: {
    readonly threadId: string
    readonly policy: SandboxPolicy
    readonly signal: AbortSignal
  }): Promise<SandboxHandle>
  /** Drop warm compute but KEEP the workspace volume (idle-reap + shutdown). */
  release(threadId: string): Promise<void>
  /** Destroy the sandbox AND its workspace volume (thread delete). */
  destroy(threadId: string): Promise<void>
  /**
   * OPTIONAL capability: open a read-only view of one thread's workspace
   * storage for a trusted, co-located host process — after the thread's turn
   * ends, while it sits idle between turns, or after `release()` dropped its
   * compute and kept the volume.
   *
   * Presence of this method IS the capability probe. Providers whose storage
   * cannot be attached twice (a ReadWriteOnce PVC, say) must omit it rather
   * than ship an implementation that works only by accident of scheduling.
   *
   * An implementation MUST NOT create, replace, start, stop or otherwise
   * disturb the thread's sandbox, MUST make writes impossible rather than
   * merely undocumented, and MUST reject rather than return an empty view when
   * the thread has no workspace storage — "produced nothing" and "does not
   * exist" are different facts to a verifier.
   *
   * This is NOT an authorization boundary. The caller already holds the
   * provider, and naming a thread id is not a claim of ownership. Gate access
   * to the calling process, not here.
   */
  openWorkspaceReader?(input: OpenWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
  /** Optional availability probe surfaced by `b4 check`. `warnings` are non-fatal notes (e.g. best-effort enforcement). */
  preflight?(): Promise<{
    readonly ok: boolean
    readonly detail?: string
    readonly warnings?: readonly string[]
  }>
}

/**
 * What a {@link WorkspaceResolver} is told about the thread it is deciding for.
 * `metadata` is the client-supplied thread metadata as stored, with B4.run's
 * reserved key stripped. It is client input: a resolver validates it and
 * decides from it, it never trusts it.
 */
export interface WorkspaceResolverInput {
  readonly threadId: string
  readonly metadata: Readonly<Record<string, unknown>>
  /** Aborted when the admitting run is cancelled. Pass it to any I/O the resolver does. */
  readonly signal: AbortSignal
}

/**
 * Host code that decides one thread's initial workspace. Called once per
 * thread, at the thread's first admission, never again: the result is
 * captured, recorded by digest in the thread's creation intent, and every
 * later turn of that thread reads the record. A subagent runs under its
 * parent's thread and resolves through the parent's record, so a resolver
 * never sees a subagent's thread id. A returned `WorkspaceDefinition` is
 * captured from the app root at that moment; a returned
 * `CapturedWorkspaceDefinition` is verified and used as is.
 */
export type WorkspaceResolver = (
  thread: WorkspaceResolverInput,
) => Promise<WorkspaceDefinition | CapturedWorkspaceDefinition>

export interface SandboxConfig {
  /**
   * The initial managed workspace: one definition for every thread, or a
   * {@link WorkspaceResolver} that decides per thread. `b4 build` captures a
   * definition into the build artifact; a resolver is captured at run time
   * and the artifact records only that a resolver is configured.
   */
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly security?: SandboxSecurityPolicy
  /** Manager-level idle reap window. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number
}
