import { stat } from "node:fs/promises"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type { SandboxPolicy } from "@b4run/workspace"
import {
  captureWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
  verifyThreadSandbox,
} from "@b4run/workspace/node"
import {
  verifyWorkspaceArtifact,
  verifyWorkspaceResolverArtifact,
} from "../build/workspace-artifact.js"
import { loadOptionalB4Config } from "../node-config.js"
import { ManagedWorkspaceManager } from "./managed-workspace-manager.js"
import { sandboxConfigShapeErrors } from "./sandbox-config-shape.js"
import { SandboxManager } from "./sandbox-manager.js"
import { stagedWorkspaceSettings, type WorkspaceProtocolSettings } from "./workspace-protocol.js"

const DEFAULT_IDLE_MS = 600_000
const DEFAULT_NETWORK: SandboxPolicy["network"] = { mode: "allow", denylist: ["169.254.169.254"] }

/** Build the per-server SandboxManager from b4.config.ts, or undefined if unconfigured. */
export async function resolveSandboxManager(
  appRoot: string,
  options: { built?: boolean; artifact?: unknown } = {},
): Promise<SandboxManager | undefined> {
  const sandbox = (await loadOptionalB4Config(appRoot))?.sandbox
  if (!sandbox) {
    if (options.artifact != null)
      throw new Error("Built workspace configuration was removed; rebuild the app")
    return undefined
  }
  const shape = sandboxConfigShapeErrors(sandbox)
  if (shape.length > 0) throw new Error(`Invalid sandbox config:\n${shape.join("\n")}`)
  if (!sandbox.workspace && !sandbox.thread && options.artifact != null)
    throw new Error("Built workspace configuration was removed; rebuild the app")
  const staged = stagedWorkspaceSettings(sandbox.stagedWorkspaces)
  const workspaceProtocol: WorkspaceProtocolSettings = {
    read: sandbox.workspaceRead === "http",
    ...(sandbox.workspaceReadTimeoutMs !== undefined
      ? { readTimeoutMs: sandbox.workspaceReadTimeoutMs }
      : {}),
    ...(staged ? { staged } : {}),
  }
  if (
    workspaceProtocol.read &&
    typeof sandbox.provider.workspaces?.openWorkspaceReader !== "function"
  )
    throw new Error(
      `sandbox.workspaceRead needs a provider whose managed workspaces can be read (openWorkspaceReader); "${sandbox.provider.name}" cannot`,
    )
  const policy: SandboxPolicy = {
    network: sandbox.network ?? DEFAULT_NETWORK,
    ...(sandbox.env ? { env: sandbox.env } : {}),
    ...(sandbox.resources ? { resources: sandbox.resources } : {}),
    ...(sandbox.security ? { security: sandbox.security } : {}),
  }
  let managed: ManagedWorkspaceManager | undefined
  const thread = sandbox.thread
  const workspace = sandbox.workspace
  if (thread) {
    if (!sandbox.provider.workspaces)
      throw new Error("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(appRoot, "workspace"))).isDirectory())
      throw new Error("Managed workspaces require app-root workspace/ capability")
    // Verified before opening the installation, so a mismatched config never creates sqlite files.
    if (options.built) verifyWorkspaceResolverArtifact(options.artifact, "thread")
    const installation = openWorkspaceInstallation(appRoot)
    try {
      managed = new ManagedWorkspaceManager({
        installation,
        resolveThread: async (input) => {
          // The workspace resolver's contract: name the thread when the host's
          // result is unusable; rethrow a cancellation unwrapped.
          try {
            const result = verifyThreadSandbox(await thread(input))
            const definition =
              "version" in result.workspace
                ? verifyCapturedWorkspaceDefinition(result.workspace)
                : await captureWorkspaceDefinition(appRoot, result.workspace, {
                    signal: input.signal,
                  })
            return {
              definition,
              ...(result.environment !== undefined ? { image: result.environment.image } : {}),
              ...(result.policy !== undefined ? { policy: result.policy } : {}),
              ...(result.permissions !== undefined ? { permissions: result.permissions } : {}),
            }
          } catch (error) {
            if (input.signal.aborted) throw error
            throw new Error(
              `Thread sandbox resolver for thread ${input.threadId}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
        },
        provider: sandbox.provider.workspaces,
        policy,
        idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        ...(staged
          ? { staged: { retentionMs: staged.retentionMs, maxStagedBytes: staged.maxStagedBytes } }
          : {}),
      })
    } catch (error) {
      installation.close()
      throw error
    }
  } else if (workspace) {
    if (!sandbox.provider.workspaces)
      throw new Error("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(appRoot, "workspace"))).isDirectory())
      throw new Error("Managed workspaces require app-root workspace/ capability")
    if (typeof workspace === "function") {
      // A resolver has nothing to capture at boot. In a built app the artifact
      // must say so, or the config changed form since the build. Verified before
      // opening the installation, so a mismatched config never creates sqlite files.
      if (options.built) verifyWorkspaceResolverArtifact(options.artifact, "resolver")
      const installation = openWorkspaceInstallation(appRoot)
      try {
        managed = new ManagedWorkspaceManager({
          installation,
          captureDefinition: async (thread) => {
            // Name the thread when the host's result is unusable, so the
            // error reads as "your resolver returned a bad workspace", not as a
            // framework shape complaint about an object the operator never wrote.
            // A cancellation is rethrown unwrapped so callers can still detect it.
            try {
              const resolved = await workspace(thread)
              if (resolved === null || typeof resolved !== "object")
                throw new Error("returned no workspace definition")
              return "version" in resolved
                ? verifyCapturedWorkspaceDefinition(resolved)
                : await captureWorkspaceDefinition(appRoot, resolved, { signal: thread.signal })
            } catch (error) {
              if (thread.signal.aborted) throw error
              throw new Error(
                `Workspace resolver for thread ${thread.threadId}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              )
            }
          },
          provider: sandbox.provider.workspaces,
          policy,
          idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
          ...(staged
            ? { staged: { retentionMs: staged.retentionMs, maxStagedBytes: staged.maxStagedBytes } }
            : {}),
        })
      } catch (error) {
        installation.close()
        throw error
      }
    } else {
      // Computed before opening the installation, so a failing static config
      // never creates sqlite files.
      const definition = options.built
        ? verifyWorkspaceArtifact(options.artifact, workspace)
        : await captureWorkspaceDefinition(appRoot, workspace)
      const installation = openWorkspaceInstallation(appRoot)
      try {
        managed = new ManagedWorkspaceManager({
          installation,
          definition,
          ...(!options.built
            ? { captureDefinition: () => captureWorkspaceDefinition(appRoot, workspace) }
            : {}),
          provider: sandbox.provider.workspaces,
          policy,
          idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        })
      } catch (error) {
        installation.close()
        throw error
      }
    }
  }
  return new SandboxManager({
    ...(managed ? { managed } : {}),
    workspaceProtocol,
    provider: sandbox.provider,
    policy,
    idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  })
}
