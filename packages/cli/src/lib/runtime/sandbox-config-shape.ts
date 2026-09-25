import {
  STAGED_QUOTA_MAX_BYTES,
  STAGED_RETENTION_MAX_MS,
  STAGED_RETENTION_MIN_MS,
  STAGED_UPLOAD_MAX_BYTES,
  STAGED_UPLOAD_TIMEOUT_MAX_MS,
  STAGED_UPLOAD_TIMEOUT_MIN_MS,
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
  "stagedWorkspaces",
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
  errors.push(...stagedWorkspacesErrors(block))
  return errors
}

const STAGED_LIMITS = [
  "maxUploadBytes",
  "retentionMs",
  "maxStagedBytes",
  "uploadTimeoutMs",
] as const

function integerIn(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

/**
 * `stagedWorkspaces`: `true`, `false`, or bounded limits, and only beside a
 * resolver. A static `workspace` would serve every thread the same files and
 * silently ignore what a creator staged, so it is refused rather than accepted.
 */
function stagedWorkspacesErrors(block: Record<string, unknown>): string[] {
  const staged = block.stagedWorkspaces
  if (staged === undefined || staged === false) return []
  if (staged !== true && (staged === null || typeof staged !== "object" || Array.isArray(staged)))
    return [
      `b4.config sandbox.stagedWorkspaces must be true, false or { ${STAGED_LIMITS.map((key) => `${key}?`).join(", ")} } (got: ${JSON.stringify(staged) ?? typeof staged}).`,
    ]
  const errors: string[] = []
  if (staged !== true) {
    const limits = staged as Record<string, unknown>
    for (const key of Object.keys(limits))
      if (!(STAGED_LIMITS as readonly string[]).includes(key))
        errors.push(
          `b4.config sandbox.stagedWorkspaces.${key} is not an option (known: ${STAGED_LIMITS.join(", ")}).`,
        )
    const bound = (key: (typeof STAGED_LIMITS)[number], min: number, max: number) => {
      const value = limits[key]
      if (value !== undefined && !integerIn(value, min, max))
        errors.push(
          `b4.config sandbox.stagedWorkspaces.${key} must be an integer from ${min} to ${max} (got: ${JSON.stringify(value) ?? typeof value}).`,
        )
    }
    bound("maxUploadBytes", 1, STAGED_UPLOAD_MAX_BYTES)
    bound("retentionMs", STAGED_RETENTION_MIN_MS, STAGED_RETENTION_MAX_MS)
    bound("maxStagedBytes", 1, STAGED_QUOTA_MAX_BYTES)
    bound("uploadTimeoutMs", STAGED_UPLOAD_TIMEOUT_MIN_MS, STAGED_UPLOAD_TIMEOUT_MAX_MS)
  }
  if (block.thread === undefined && typeof block.workspace !== "function")
    errors.push(
      "b4.config sandbox.stagedWorkspaces needs a resolver (sandbox.thread, or a function sandbox.workspace): a static workspace would ignore what was staged.",
    )
  return errors
}
