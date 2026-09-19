import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import {
  type SandboxProvider,
  type SandboxSecurityPolicy,
  type SandboxWorkspaceReader,
  scopedWorkspaceReader,
  WorkspaceLifecycleError,
} from "@b4run/workspace"
import { verifyReadyWorkspace } from "@b4run/workspace/node"

export interface ManagedWorkspaceReadOptions {
  /** The worker app's root: where `openWorkspaceInstallation(appRoot)` keeps its state. */
  readonly appRoot: string
  /** The worker's own provider kind, scope and image, constructed in THIS process. */
  readonly provider: SandboxProvider
  readonly threadId: string
  readonly signal: AbortSignal
  /** Mirror the worker's `sandbox.security.runAsNonRoot` when it relaxed the default. */
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}

/**
 * Open a read-only view of a MANAGED workspace — one an app created through
 * `sandbox.workspace` — for a trusted, co-located host process.
 *
 * A managed workspace is addressed by its published record, not by its thread
 * id, so the thread id is resolved through the worker's own installation store
 * first, read-only and without taking the owner's admission lock. There is
 * deliberately no fallback to `provider.openWorkspaceReader(threadId)`: an
 * app with a workspace definition has no provider storage for its threads, and
 * a helper that tried it anyway would answer "no such thread" with someone
 * else's bytes.
 *
 * This is addressing, not authorization: gate access to the calling process.
 */
export async function openManagedWorkspaceReader(
  options: ManagedWorkspaceReadOptions,
): Promise<SandboxWorkspaceReader> {
  const { appRoot, provider, threadId, signal } = options
  signal.throwIfAborted()
  const workspaces = provider.workspaces
  if (!workspaces) {
    throw new Error(`Sandbox provider "${provider.name}" does not support managed workspaces`)
  }
  const open = workspaces.openWorkspaceReader
  if (typeof open !== "function") {
    throw new Error(
      `Managed workspace provider "${workspaces.name}" does not support reading a workspace`,
    )
  }
  const installation = openWorkspaceInstallationReader(appRoot)
  let record: ReturnType<typeof installation.associations.get>
  try {
    record = installation.associations.get(threadId)
  } finally {
    installation.close()
  }
  if (!record) {
    throw new WorkspaceLifecycleError(
      "lost",
      `No managed workspace for thread "${threadId}" under ${appRoot}`,
    )
  }
  if (record.state === "deleting" || record.state === "deleted") {
    throw new WorkspaceLifecycleError(
      "lost",
      `Managed workspace for thread "${threadId}" is deleted`,
    )
  }
  if (record.state === "creating" || !record.ready) {
    throw new WorkspaceLifecycleError(
      "retryable",
      `Managed workspace for thread "${threadId}" is not published yet`,
    )
  }
  const ready = verifyReadyWorkspace(record.ready, record.intent)
  const expiresAt = ready.provenance.retention.expiresAt
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new WorkspaceLifecycleError(
      "expired",
      `Managed workspace for thread "${threadId}" passed its retention deadline`,
    )
  }
  return open.call(workspaces, {
    workspace: ready,
    signal,
    ...(options.runAsNonRoot === undefined ? {} : { runAsNonRoot: options.runAsNonRoot }),
  })
}

/** `openManagedWorkspaceReader` with the always-close lifetime of `withWorkspaceReader`. */
export function withManagedWorkspaceReader<T>(
  options: ManagedWorkspaceReadOptions,
  operation: (reader: SandboxWorkspaceReader) => Promise<T>,
): Promise<T> {
  return scopedWorkspaceReader(() => openManagedWorkspaceReader(options), operation)
}
