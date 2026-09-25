import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { B4Config } from "@b4run/core"
import type { SandboxProvider } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { sandboxConfigShapeErrors } from "./sandbox-config-shape.js"

/** Validate the b4.config.ts sandbox block + run the provider preflight. */
export async function collectSandboxErrors(
  config: Pick<B4Config, "sandbox">,
  appRoot?: string,
): Promise<{ readonly errors: readonly string[]; readonly warnings: readonly string[] }> {
  const sandbox = config.sandbox
  if (!sandbox) return { errors: [], warnings: [] }
  const shape = sandboxConfigShapeErrors(sandbox)
  if (shape.length > 0) return { errors: shape, warnings: [] }
  const errors: string[] = []
  const warnings: string[] = []
  const p = sandbox.provider as Partial<SandboxProvider> | undefined
  if (
    !p ||
    typeof p.acquire !== "function" ||
    typeof p.release !== "function" ||
    typeof p.destroy !== "function"
  ) {
    errors.push(
      `b4.config sandbox.provider must implement acquire/release/destroy (got: ${p?.name ?? "undefined"}).`,
    )
    return { errors, warnings }
  }
  if (sandbox.workspace || sandbox.thread) {
    if (!p.workspaces) errors.push("Sandbox provider does not support managed workspaces")
    if (appRoot) {
      try {
        if (!(await stat(join(appRoot, "workspace"))).isDirectory())
          throw new Error("workspace/ must be a directory")
        // A resolver's result, workspace or whole sandbox, exists only once a thread does.
        if (sandbox.workspace !== undefined && typeof sandbox.workspace !== "function")
          await captureWorkspaceDefinition(appRoot, sandbox.workspace)
      } catch (error) {
        errors.push(
          `Invalid managed workspace: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  if (typeof p.preflight === "function") {
    try {
      const result = await p.preflight()
      if (!result.ok) {
        errors.push(
          `Sandbox provider "${p.name}" preflight failed: ${result.detail ?? "unavailable"}.`,
        )
      } else if (result.warnings) {
        warnings.push(...result.warnings)
      }
    } catch (error) {
      errors.push(
        `Sandbox provider "${p.name}" preflight threw: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }
  const sec = sandbox.security
  if (sec) {
    if (sec.pidsLimit !== undefined && (!Number.isInteger(sec.pidsLimit) || sec.pidsLimit <= 0)) {
      errors.push(
        `b4.config sandbox.security.pidsLimit must be a positive integer (got: ${String(sec.pidsLimit)}).`,
      )
    }
    if (sec.runAsNonRoot === null) {
      errors.push(
        "b4.config sandbox.security.runAsNonRoot must be a boolean or a { uid, gid } object, not null.",
      )
    } else if (typeof sec.runAsNonRoot === "object") {
      const { uid, gid } = sec.runAsNonRoot
      if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
        errors.push(
          "b4.config sandbox.security.runAsNonRoot uid/gid must be non-negative integers.",
        )
      }
    }
  }
  return { errors, warnings }
}
