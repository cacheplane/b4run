import { stat } from "node:fs/promises"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type { SandboxPolicy } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { verifyWorkspaceArtifact } from "../build/workspace-artifact.js"
import { loadOptionalB4Config } from "../node-config.js"
import { ManagedWorkspaceManager } from "./managed-workspace-manager.js"
import { SandboxManager } from "./sandbox-manager.js"

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
  if (!sandbox.workspace && options.artifact != null)
    throw new Error("Built workspace configuration was removed; rebuild the app")
  const policy: SandboxPolicy = {
    network: sandbox.network ?? DEFAULT_NETWORK,
    ...(sandbox.env ? { env: sandbox.env } : {}),
    ...(sandbox.resources ? { resources: sandbox.resources } : {}),
    ...(sandbox.security ? { security: sandbox.security } : {}),
  }
  let managed: ManagedWorkspaceManager | undefined
  if (sandbox.workspace) {
    if (!sandbox.provider.workspaces)
      throw new Error("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(appRoot, "workspace"))).isDirectory())
      throw new Error("Managed workspaces require app-root workspace/ capability")
    const definition = options.built
      ? verifyWorkspaceArtifact(options.artifact, sandbox.workspace)
      : await captureWorkspaceDefinition(appRoot, sandbox.workspace)
    const installation = openWorkspaceInstallation(appRoot)
    try {
      managed = new ManagedWorkspaceManager({
        installation,
        definition,
        ...(!options.built
          ? { captureDefinition: () => captureWorkspaceDefinition(appRoot, sandbox.workspace!) }
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
  return new SandboxManager({
    ...(managed ? { managed } : {}),
    provider: sandbox.provider,
    policy,
    idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  })
}
