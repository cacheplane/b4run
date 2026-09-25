import {
  WORKSPACE_READ_TIMEOUT_MAX_MS,
  WORKSPACE_READ_TIMEOUT_MIN_MS,
} from "./workspace-protocol.js"

/**
 * The `sandbox` block's shape, checked where the config is used: `b4 check`,
 * `b4 build` and boot. B4Config has no runtime schema, so without this a
 * misspelt `thred:` would be dropped silently and every thread would run in a
 * per-app sandbox under the app's policy and permissions: a fail-open on a typo.
 */
const SANDBOX_KEYS = [
  "workspace",
  "thread",
  "workspaceRead",
  "workspaceReadTimeoutMs",
  "provider",
  "network",
  "env",
  "resources",
  "security",
  "idleTimeoutMs",
] as const

export function sandboxConfigShapeErrors(sandbox: unknown): string[] {
  if (sandbox === undefined) return []
  if (sandbox === null || typeof sandbox !== "object" || Array.isArray(sandbox))
    return ["b4.config sandbox must be an object."]
  const block = sandbox as Record<string, unknown>
  const errors: string[] = []
  for (const key of Object.keys(block))
    if (!(SANDBOX_KEYS as readonly string[]).includes(key))
      errors.push(
        `b4.config sandbox.${key} is not a sandbox option (known: ${SANDBOX_KEYS.join(", ")}).`,
      )
  if (block.thread !== undefined && typeof block.thread !== "function")
    errors.push(
      "b4.config sandbox.thread must be a function of the thread (a ThreadSandboxResolver).",
    )
  if (block.thread !== undefined && block.workspace !== undefined)
    errors.push(
      "b4.config sandbox.thread and sandbox.workspace are exclusive: a thread resolver returns the thread's workspace itself.",
    )
  if (
    block.workspace !== undefined &&
    typeof block.workspace !== "function" &&
    (block.workspace === null ||
      typeof block.workspace !== "object" ||
      Array.isArray(block.workspace))
  )
    errors.push(
      "b4.config sandbox.workspace must be a workspace definition or a resolver function.",
    )
  if (block.workspaceRead !== undefined) {
    if (block.workspaceRead !== "http")
      errors.push(
        `b4.config sandbox.workspaceRead must be "http" (got: ${JSON.stringify(block.workspaceRead) ?? typeof block.workspaceRead}).`,
      )
    else if (block.workspace === undefined && block.thread === undefined)
      errors.push(
        "b4.config sandbox.workspaceRead needs managed workspaces: set sandbox.workspace or sandbox.thread.",
      )
  }
  if (block.workspaceReadTimeoutMs !== undefined) {
    const value = block.workspaceReadTimeoutMs
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < WORKSPACE_READ_TIMEOUT_MIN_MS ||
      (value as number) > WORKSPACE_READ_TIMEOUT_MAX_MS
    )
      errors.push(
        `b4.config sandbox.workspaceReadTimeoutMs must be an integer from ${WORKSPACE_READ_TIMEOUT_MIN_MS} to ${WORKSPACE_READ_TIMEOUT_MAX_MS} (got: ${JSON.stringify(value) ?? typeof value}).`,
      )
    else if (block.workspaceRead === undefined)
      errors.push(
        'b4.config sandbox.workspaceReadTimeoutMs applies only with sandbox.workspaceRead: "http".',
      )
  }
  return errors
}
