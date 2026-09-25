import type {
  SandboxPolicy,
  ThreadSandbox,
  ThreadSandboxPolicy,
  ThreadSandboxRecord,
} from "./sandbox-types.js"

/**
 * Validation for what a thread-sandbox resolver returns and what B4.run stores
 * for it. Strict everywhere: an unknown key is refused by name, never dropped,
 * because a dropped key is a thread silently running under the app's broader
 * default instead of what its resolver asked for.
 */

/** Letters, digits and `._/:@-`, not starting with a symbol: never readable as a CLI flag. */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${what} must be a plain object`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Reflect.ownKeys(value).filter(
    (key) => typeof key !== "string" || !allowed.includes(key),
  )
  if (extra.length > 0)
    throw new Error(
      `${what} has unsupported key ${extra.map(String).join(", ")} (allowed: ${allowed.join(", ")})`,
    )
}

function positive(value: unknown, what: string, integer: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${what} must be a positive ${integer ? "integer" : "number"}`)
  return value
}

export function verifyImageReference(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_REFERENCE.test(value))
    throw new Error(
      "A thread's image must be an image reference: letters, digits and ._/:@-, starting with a letter or digit, at most 512 characters",
    )
  return value
}

function network(value: unknown): SandboxPolicy["network"] {
  const n = plainObject(value, "policy.network")
  if ("allowlist" in n || "denylist" in n)
    throw new Error(
      "policy.network lists are not enforced by managed workspaces: a thread's network is deny or allow",
    )
  onlyKeys(n, ["mode"], "policy.network")
  if (n.mode !== "deny" && n.mode !== "allow")
    throw new Error('policy.network.mode must be "deny" or "allow"')
  return Object.freeze({ mode: n.mode })
}

function env(value: unknown): Readonly<Record<string, string>> {
  const e = plainObject(value, "policy.env")
  if (Reflect.ownKeys(e).some((key) => typeof key !== "string"))
    throw new Error("policy.env names must be strings")
  const names = Object.keys(e).sort()
  if (names.length > 256) throw new Error("policy.env has more than 256 variables")
  const out: Record<string, string> = {}
  for (const name of names) {
    if (!ENV_NAME.test(name))
      throw new Error(`policy.env name ${JSON.stringify(name)} is not a valid variable name`)
    const text = e[name]
    if (typeof text !== "string" || text.length > 32_768 || text.includes("\u0000"))
      throw new Error(`policy.env.${name} must be a string without NUL, at most 32768 characters`)
    out[name] = text
  }
  return Object.freeze(out)
}

function resources(value: unknown): NonNullable<ThreadSandboxPolicy["resources"]> {
  const r = plainObject(value, "policy.resources")
  if ("diskGb" in r)
    throw new Error(
      "policy.resources.diskGb is not enforced by managed workspaces: a thread cannot size its disk",
    )
  onlyKeys(r, ["memoryMb", "cpus", "timeoutMs"], "policy.resources")
  return Object.freeze({
    ...(r.memoryMb !== undefined
      ? { memoryMb: positive(r.memoryMb, "policy.resources.memoryMb", true) }
      : {}),
    ...(r.cpus !== undefined ? { cpus: positive(r.cpus, "policy.resources.cpus", false) } : {}),
    ...(r.timeoutMs !== undefined
      ? { timeoutMs: positive(r.timeoutMs, "policy.resources.timeoutMs", true) }
      : {}),
  })
}

/** A thread's policy overrides, normalized: fixed key order, sorted env names, frozen. */
export function verifyThreadSandboxPolicy(value: unknown): ThreadSandboxPolicy {
  const policy = plainObject(value, "A thread's sandbox policy")
  onlyKeys(policy, ["network", "env", "resources"], "A thread's sandbox policy")
  return Object.freeze({
    ...(policy.network !== undefined ? { network: network(policy.network) } : {}),
    ...(policy.env !== undefined ? { env: env(policy.env) } : {}),
    ...(policy.resources !== undefined ? { resources: resources(policy.resources) } : {}),
  })
}

/**
 * What a `ThreadSandboxResolver` returned, checked. The workspace is left as
 * returned: the caller captures a `WorkspaceDefinition` or verifies a
 * `CapturedWorkspaceDefinition` with the functions that own those shapes.
 */
export function verifyThreadSandbox(value: unknown): ThreadSandbox {
  const sandbox = plainObject(value, "A thread sandbox")
  onlyKeys(sandbox, ["workspace", "environment", "policy"], "A thread sandbox")
  const workspace = sandbox.workspace
  if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace))
    throw new Error("A thread sandbox must name its workspace")
  let environment: ThreadSandbox["environment"]
  if (sandbox.environment !== undefined) {
    const e = plainObject(sandbox.environment, "environment")
    onlyKeys(e, ["image"], "environment")
    environment = Object.freeze({ image: verifyImageReference(e.image) })
  }
  const policy =
    sandbox.policy === undefined ? undefined : verifyThreadSandboxPolicy(sandbox.policy)
  return Object.freeze({
    workspace: workspace as ThreadSandbox["workspace"],
    ...(environment !== undefined ? { environment } : {}),
    ...(policy !== undefined ? { policy } : {}),
  })
}

/** The stored record, normalized so `JSON.stringify` of it is its one canonical text. */
export function verifyThreadSandboxRecord(value: unknown): ThreadSandboxRecord {
  const record = plainObject(value, "A thread sandbox record")
  onlyKeys(record, ["version", "image", "policy"], "A thread sandbox record")
  if (record.version !== 1) throw new Error("Unsupported thread sandbox record version")
  return Object.freeze({
    version: 1,
    ...(record.image !== undefined ? { image: verifyImageReference(record.image) } : {}),
    ...(record.policy !== undefined ? { policy: verifyThreadSandboxPolicy(record.policy) } : {}),
  })
}
