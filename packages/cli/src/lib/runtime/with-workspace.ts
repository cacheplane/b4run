import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type {
  CapturedWorkspaceDefinition,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  WorkspaceDefinition,
} from "@b4run/workspace"
import {
  captureWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
} from "@b4run/workspace/node"
import { ManagedWorkspaceManager } from "./managed-workspace-manager.js"

export interface WithWorkspaceOptions {
  readonly appRoot: string
  /** Durable private directory dedicated to these disposable executions. One active invocation per directory. */
  readonly stateRoot: string
  readonly provider: SandboxProvider
  readonly workspace: WorkspaceDefinition | CapturedWorkspaceDefinition
  readonly policy: SandboxPolicy
  readonly signal?: AbortSignal
}
/** Run host-authored work in a fresh workspace; recover and remove prior unfinished work first. */
export async function withWorkspace<T>(
  options: WithWorkspaceOptions,
  operation: (handle: SandboxHandle) => Promise<T>,
): Promise<T> {
  if (!options.provider.workspaces) throw new Error("Provider does not support managed workspaces")
  const signal = options.signal ?? new AbortController().signal
  const definition =
    "version" in options.workspace
      ? verifyCapturedWorkspaceDefinition(options.workspace)
      : await captureWorkspaceDefinition(options.appRoot, options.workspace, { signal })
  await mkdir(options.stateRoot, { recursive: true })
  const installation = openWorkspaceInstallation(options.stateRoot)
  let manager: ManagedWorkspaceManager | undefined
  let failed = false
  let failure: unknown
  let result: T | undefined
  let threadId: string | undefined
  let release: (() => void) | undefined
  try {
    manager = new ManagedWorkspaceManager({
      installation,
      definition,
      provider: options.provider.workspaces,
      policy: options.policy,
      idleTimeoutMs: 600_000,
    })
    for (const record of installation.associations.list()) {
      if (record.state === "deleted") continue
      await manager.destroyThread(record.intent.threadId)
      manager.completeDelete(record.intent.threadId)
    }
    signal.throwIfAborted()
    threadId = randomUUID()
    release = manager.retain(threadId)
    result = await operation(await manager.getForThread(threadId, signal))
  } catch (error) {
    failed = true
    failure = error
  } finally {
    release?.()
    try {
      if (manager && threadId) {
        await manager.destroyThread(threadId)
        manager.completeDelete(threadId)
      }
      await manager?.releaseAll()
    } catch (error) {
      failure = failed
        ? new AggregateError([failure, error], "Workspace execution and cleanup failed")
        : error
      failed = true
    } finally {
      installation.close()
    }
  }
  if (failed) throw failure
  return result as T
}
