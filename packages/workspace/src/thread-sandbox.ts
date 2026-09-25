import type {
  SandboxPolicy,
  ThreadSandbox,
  ThreadSandboxPermissions,
  ThreadSandboxPolicy,
  ThreadSandboxRecord,
} from "./sandbox-types.js"

/**
 * Validation for what a thread-sandbox resolver returns and what B4.run stores
 * for it. Strict everywhere: an unknown key is refused by name, never dropped,
 * because a dropped key is a thread silently running under the app's broader
 * default instead of what its resolver asked for.
 */

/**
 * The largest a thread's stored record may be, as UTF-8 JSON. A policy can
 * pass every per-field bound (256 variables of 32768 characters) and still
 * exceed it, so the manager checks the resolved record against this before
 * any provider call, and the store refuses anything larger.
 */
export const MAX_THREAD_SANDBOX_RECORD_BYTES = 256 * 1024

/** The size `JSON.stringify` of a verified record takes when stored. */
export function threadSandboxRecordBytes(record: ThreadSandboxRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength
}

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

/**
 * An own data property, read once. Inherited values (a polluted
 * `Object.prototype`) read as absent, and an accessor is refused: a getter
 * could answer the check and the copy differently.
 */
function own(value: Record<string, unknown>, key: string, what: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor)) throw new Error(`${what}.${key} must be a data property`)
  return descriptor.value
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
  if (Object.hasOwn(n, "allowlist") || Object.hasOwn(n, "denylist"))
    throw new Error(
      "policy.network lists are not enforced by managed workspaces: a thread's network is deny or allow",
    )
  onlyKeys(n, ["mode"], "policy.network")
  const mode = own(n, "mode", "policy.network")
  if (mode !== "deny" && mode !== "allow")
    throw new Error('policy.network.mode must be "deny" or "allow"')
  return Object.freeze({ mode })
}

function env(value: unknown): Readonly<Record<string, string>> {
  const e = plainObject(value, "policy.env")
  // Every own key, not only enumerable ones: a non-enumerable variable is refused, never dropped.
  const keys = Reflect.ownKeys(e)
  if (keys.some((key) => typeof key !== "string"))
    throw new Error("policy.env names must be strings")
  const names = (keys as string[]).sort()
  for (const name of names)
    if (!Object.getOwnPropertyDescriptor(e, name)?.enumerable)
      throw new Error(`policy.env.${name} must be an enumerable property`)
  if (names.length > 256) throw new Error("policy.env has more than 256 variables")
  const out: Record<string, string> = {}
  for (const name of names) {
    // `__proto__` matches the pattern but cannot be an own key of a plain object: refused, never dropped.
    if (!ENV_NAME.test(name) || name === "__proto__")
      throw new Error(`policy.env name ${JSON.stringify(name)} is not a valid variable name`)
    const text = own(e, name, "policy.env")
    if (typeof text !== "string" || text.length > 32_768 || text.includes("\u0000"))
      throw new Error(`policy.env.${name} must be a string without NUL, at most 32768 characters`)
    out[name] = text
  }
  return Object.freeze(out)
}

function resources(value: unknown): NonNullable<ThreadSandboxPolicy["resources"]> {
  const r = plainObject(value, "policy.resources")
  if (Object.hasOwn(r, "diskGb"))
    throw new Error(
      "policy.resources.diskGb is not enforced by managed workspaces: a thread cannot size its disk",
    )
  onlyKeys(r, ["memoryMb", "cpus", "timeoutMs"], "policy.resources")
  const memoryMb = own(r, "memoryMb", "policy.resources")
  const cpus = own(r, "cpus", "policy.resources")
  const timeoutMs = own(r, "timeoutMs", "policy.resources")
  return Object.freeze({
    ...(memoryMb !== undefined
      ? { memoryMb: positive(memoryMb, "policy.resources.memoryMb", true) }
      : {}),
    ...(cpus !== undefined ? { cpus: positive(cpus, "policy.resources.cpus", false) } : {}),
    ...(timeoutMs !== undefined
      ? { timeoutMs: positive(timeoutMs, "policy.resources.timeoutMs", true) }
      : {}),
  })
}

/** A thread's policy overrides, normalized: fixed key order, sorted env names, frozen. */
export function verifyThreadSandboxPolicy(value: unknown): ThreadSandboxPolicy {
  const policy = plainObject(value, "A thread's sandbox policy")
  onlyKeys(policy, ["network", "env", "resources"], "A thread's sandbox policy")
  const n = own(policy, "network", "policy")
  const e = own(policy, "env", "policy")
  const r = own(policy, "resources", "policy")
  return Object.freeze({
    ...(n !== undefined ? { network: network(n) } : {}),
    ...(e !== undefined ? { env: env(e) } : {}),
    ...(r !== undefined ? { resources: resources(r) } : {}),
  })
}

function patterns(value: unknown, what: string): Readonly<Record<string, readonly string[]>> {
  const map = plainObject(value, what)
  // Every own key, not only enumerable ones: a hidden tool is refused, never dropped.
  const keys = Reflect.ownKeys(map)
  if (keys.some((key) => typeof key !== "string"))
    throw new Error(`${what} tool names must be strings`)
  const tools = (keys as string[]).sort()
  if (tools.length > 64) throw new Error(`${what} names more than 64 tools`)
  const out: Record<string, readonly string[]> = {}
  for (const tool of tools) {
    // `__proto__` can be an own key (JSON.parse, a computed key) but not an ordinary one on the copy.
    if (
      !tool ||
      tool.length > 256 ||
      Array.from(tool).some((c) => c.charCodeAt(0) < 0x20) ||
      tool === "__proto__"
    )
      throw new Error(`${what} tool name ${JSON.stringify(tool)} is invalid`)
    if (!Object.getOwnPropertyDescriptor(map, tool)?.enumerable)
      throw new Error(`${what}.${tool} must be an enumerable property`)
    const list = own(map, tool, what)
    if (
      !Array.isArray(list) ||
      Object.getPrototypeOf(list) !== Array.prototype ||
      list.length > 1024 ||
      Reflect.ownKeys(list).length !== list.length + 1
    )
      throw new Error(`${what}.${tool} must be a list of at most 1024 patterns without NUL`)
    const copy: string[] = []
    for (let index = 0; index < list.length; index++) {
      const pattern = own(
        list as unknown as Record<string, unknown>,
        String(index),
        `${what}.${tool}`,
      )
      if (typeof pattern !== "string" || pattern.length > 4096 || pattern.includes("\u0000"))
        throw new Error(`${what}.${tool} must be a list of at most 1024 patterns without NUL`)
      if (pattern === "")
        throw new Error(
          `${what}.${tool}: an empty pattern matches every candidate; name what to ${what.endsWith("deny") ? "deny" : "allow"}`,
        )
      copy.push(pattern)
    }
    out[tool] = Object.freeze(copy)
  }
  return Object.freeze(out)
}

/** A thread's own permission lists, normalized: fixed key order, sorted tool names, frozen. */
export function verifyThreadSandboxPermissions(value: unknown): ThreadSandboxPermissions {
  const permissions = plainObject(value, "A thread's permissions")
  onlyKeys(permissions, ["allow", "deny"], "A thread's permissions")
  const allow = own(permissions, "allow", "permissions")
  const deny = own(permissions, "deny", "permissions")
  return Object.freeze({
    ...(allow !== undefined ? { allow: patterns(allow, "permissions.allow") } : {}),
    ...(deny !== undefined ? { deny: patterns(deny, "permissions.deny") } : {}),
  })
}

/**
 * What a `ThreadSandboxResolver` returned, checked. The workspace is left as
 * returned: the caller captures a `WorkspaceDefinition` or verifies a
 * `CapturedWorkspaceDefinition` with the functions that own those shapes.
 */
export function verifyThreadSandbox(value: unknown): ThreadSandbox {
  const sandbox = plainObject(value, "A thread sandbox")
  onlyKeys(sandbox, ["workspace", "environment", "policy", "permissions"], "A thread sandbox")
  const workspace = own(sandbox, "workspace", "A thread sandbox")
  if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace))
    throw new Error("A thread sandbox must name its workspace")
  let environment: ThreadSandbox["environment"]
  const rawEnvironment = own(sandbox, "environment", "A thread sandbox")
  if (rawEnvironment !== undefined) {
    const e = plainObject(rawEnvironment, "environment")
    onlyKeys(e, ["image"], "environment")
    environment = Object.freeze({ image: verifyImageReference(own(e, "image", "environment")) })
  }
  const rawPolicy = own(sandbox, "policy", "A thread sandbox")
  const policy = rawPolicy === undefined ? undefined : verifyThreadSandboxPolicy(rawPolicy)
  const rawPermissions = own(sandbox, "permissions", "A thread sandbox")
  const permissions =
    rawPermissions === undefined ? undefined : verifyThreadSandboxPermissions(rawPermissions)
  return Object.freeze({
    workspace: workspace as ThreadSandbox["workspace"],
    ...(environment !== undefined ? { environment } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  })
}

/** The stored record, normalized so `JSON.stringify` of it is its one canonical text. */
export function verifyThreadSandboxRecord(value: unknown): ThreadSandboxRecord {
  const record = plainObject(value, "A thread sandbox record")
  onlyKeys(record, ["version", "image", "policy", "permissions"], "A thread sandbox record")
  if (own(record, "version", "A thread sandbox record") !== 1)
    throw new Error("Unsupported thread sandbox record version")
  const image = own(record, "image", "A thread sandbox record")
  const policy = own(record, "policy", "A thread sandbox record")
  const permissions = own(record, "permissions", "A thread sandbox record")
  return Object.freeze({
    version: 1,
    ...(image !== undefined ? { image: verifyImageReference(image) } : {}),
    ...(policy !== undefined ? { policy: verifyThreadSandboxPolicy(policy) } : {}),
    ...(permissions !== undefined
      ? { permissions: verifyThreadSandboxPermissions(permissions) }
      : {}),
  })
}
