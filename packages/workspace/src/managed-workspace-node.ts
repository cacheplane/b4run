import { createHash } from "node:crypto"
import type {
  CapturedWorkspaceDefinition,
  CreationStatus,
  ReadyWorkspace,
  WorkspaceCreateIntent,
  WorkspaceDefinition,
  WorkspaceEnvironment,
  WorkspaceLifecycleErrorCode,
  WorkspaceProvenance,
} from "./managed-workspace.js"
import { verifySourceBundle } from "./source-bundle.js"
import { captureWorkspaceSource, type WorkspaceSourceDefinition } from "./source-capture.js"
import { checkPaths, entries, portablePath, record } from "./source-validation.js"

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== "object") throw new Error("Expected workspace record")
  const keys = Reflect.ownKeys(value)
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
  )
    throw new Error("Unexpected workspace fields")
  return record(value, keys as string[])
}
function text(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    Buffer.from(value).toString("utf8") !== value
  )
    throw new Error("Invalid workspace string")
  return value
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new Error("Invalid workspace UUID")
  return value
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error("Invalid workspace digest")
  return value
}
function baseline(value: Record<string, unknown>): { readonly baseline?: "git" } {
  if (!("baseline" in value)) return {}
  if (value.baseline !== "git") throw new Error("Unsupported workspace baseline")
  return { baseline: "git" }
}
function environment(value: unknown): WorkspaceEnvironment {
  const env = shape(value, ["binding", "identity"])
  const binding = shape(env.binding, ["provider", "scope", "account"])
  return Object.freeze({
    binding: Object.freeze({
      provider: text(binding.provider),
      scope: text(binding.scope),
      account: text(binding.account),
    }),
    identity: text(env.identity, 4096),
  })
}
function links(
  value: unknown,
  canonical: boolean,
): CapturedWorkspaceDefinition["environmentLinks"] {
  const result = entries(value).map((item) => {
    const link = shape(item, ["path", "target"])
    const path = portablePath(link.path)
    if (
      typeof link.target !== "string" ||
      !link.target.startsWith("/") ||
      link.target.length > 1024
    )
      throw new Error("Environment link target must be absolute")
    const target = `/${portablePath(link.target.slice(1))}`
    return Object.freeze({ path, target })
  })
  checkPaths(result)
  if (canonical && result.some((item, i) => i > 0 && (result[i - 1]?.path ?? "") >= item.path))
    throw new Error("Noncanonical environment link order")
  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return Object.freeze(result)
}
function paths(definition: CapturedWorkspaceDefinition) {
  checkPaths([
    ...definition.source.files,
    ...definition.environmentLinks,
    ...(definition.baseline === "git" ? [{ path: ".git" }] : []),
  ])
}
export function verifyCapturedWorkspaceDefinition(value: unknown): CapturedWorkspaceDefinition {
  const input = shape(value, ["version", "source", "environmentLinks"], ["baseline"])
  if (input.version !== 1) throw new Error("Unsupported workspace definition version")
  const result = Object.freeze({
    version: 1 as const,
    source: verifySourceBundle(input.source),
    environmentLinks: links(input.environmentLinks, true),
    ...baseline(input),
  })
  paths(result)
  return result
}
export async function captureWorkspaceDefinition(
  appRoot: string,
  definition: WorkspaceDefinition,
  options: { readonly signal?: AbortSignal } = {},
): Promise<CapturedWorkspaceDefinition> {
  const input = shape(definition, ["source"], ["environmentLinks", "baseline"])
  const opts = shape(options, [], ["signal"])
  if ("signal" in opts && !(opts.signal instanceof AbortSignal))
    throw new Error("Invalid workspace capture signal")
  const environmentLinks = links("environmentLinks" in input ? input.environmentLinks : [], false)
  const selectedBaseline = baseline(input)
  const source = await captureWorkspaceSource(
    appRoot,
    input.source as WorkspaceSourceDefinition,
    opts as { signal?: AbortSignal },
  )
  return verifyCapturedWorkspaceDefinition({
    version: 1,
    source,
    environmentLinks,
    ...selectedBaseline,
  })
}
function hashIntent(value: Omit<WorkspaceCreateIntent, "digest">): string {
  return createHash("sha256")
    .update(JSON.stringify(["b4-workspace-intent-v1", value]))
    .digest("hex")
}
function intentBody(value: Record<string, unknown>): Omit<WorkspaceCreateIntent, "digest"> {
  if (value.version !== 1) throw new Error("Unsupported workspace intent version")
  const body = {
    version: 1 as const,
    operationId: uuid(value.operationId),
    installationId: uuid(value.installationId),
    threadId: text(value.threadId),
    sourceDigest: digest(value.sourceDigest),
    environment: environment(value.environment),
    environmentLinks: links(value.environmentLinks, true),
    ...baseline(value),
  }
  if (body.baseline) checkPaths([...body.environmentLinks, { path: ".git" }])
  return body
}
export function createWorkspaceIntent(input: {
  readonly operationId: string
  readonly installationId: string
  readonly threadId: string
  readonly definition: CapturedWorkspaceDefinition
  readonly environment: WorkspaceEnvironment
}): WorkspaceCreateIntent {
  const value = shape(input, [
    "operationId",
    "installationId",
    "threadId",
    "definition",
    "environment",
  ])
  const definition = verifyCapturedWorkspaceDefinition(value.definition)
  const body = intentBody({
    version: 1,
    operationId: value.operationId,
    installationId: value.installationId,
    threadId: value.threadId,
    sourceDigest: definition.source.digest,
    environment: value.environment,
    environmentLinks: definition.environmentLinks,
    ...(definition.baseline ? { baseline: definition.baseline } : {}),
  })
  return Object.freeze({ ...body, digest: hashIntent(body) })
}
export function verifyWorkspaceIntent(value: unknown): WorkspaceCreateIntent {
  const input = shape(
    value,
    [
      "version",
      "operationId",
      "installationId",
      "threadId",
      "sourceDigest",
      "environment",
      "environmentLinks",
      "digest",
    ],
    ["baseline"],
  )
  const body = intentBody(input)
  if (digest(input.digest) !== hashIntent(body)) throw new Error("Workspace intent digest mismatch")
  return Object.freeze({ ...body, digest: input.digest as string })
}
function resource(value: unknown): Readonly<Record<string, string>> {
  const input = shape(
    value,
    [],
    value !== null && typeof value === "object" ? Object.keys(value) : [],
  )
  if (Object.keys(input).length > 32) throw new Error("Workspace resource exceeds key limit")
  const result: Record<string, string> = {}
  for (const key of Object.keys(input).sort()) {
    text(key, 256)
    Object.defineProperty(result, key, { value: text(input[key], 16384), enumerable: true })
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384)
    throw new Error("Workspace resource exceeds byte limit")
  return Object.freeze(result)
}
export function verifyReadyWorkspace(
  value: unknown,
  intent: WorkspaceCreateIntent,
): ReadyWorkspace {
  const expected = verifyWorkspaceIntent(intent)
  const input = shape(value, ["reference", "provenance"])
  const ref = shape(input.reference, [
    "version",
    "operationId",
    "installationId",
    "threadId",
    "intentDigest",
    "resource",
  ])
  if (
    ref.version !== 1 ||
    ref.operationId !== expected.operationId ||
    ref.installationId !== expected.installationId ||
    ref.threadId !== expected.threadId ||
    ref.intentDigest !== expected.digest
  )
    throw new Error("Workspace reference does not match intent")
  const provenance = shape(
    input.provenance,
    ["sourceDigest", "environment", "retention"],
    ["baselineCommit"],
  )
  const env = environment(provenance.environment)
  if (
    provenance.sourceDigest !== expected.sourceDigest ||
    JSON.stringify(env) !== JSON.stringify(expected.environment)
  )
    throw new Error("Workspace provenance does not match intent")
  if (
    expected.baseline === "git"
      ? typeof provenance.baselineCommit !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(provenance.baselineCommit)
      : "baselineCommit" in provenance
  )
    throw new Error("Workspace baseline does not match intent")
  const retention = shape(provenance.retention, ["filesystem", "memory"], ["expiresAt"])
  if (retention.filesystem !== "until-destroy" && retention.filesystem !== "expires")
    throw new Error("Invalid workspace filesystem retention")
  if (retention.memory !== "discarded" && retention.memory !== "retained")
    throw new Error("Invalid workspace memory retention")
  if (retention.filesystem === "expires") {
    if (
      typeof retention.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(retention.expiresAt)) ||
      new Date(retention.expiresAt).toISOString() !== retention.expiresAt
    )
      throw new Error("Invalid workspace expiration deadline")
  } else if ("expiresAt" in retention) throw new Error("Unexpected workspace expiration deadline")
  const validatedRetention: WorkspaceProvenance["retention"] = Object.freeze({
    filesystem: retention.filesystem,
    memory: retention.memory,
    ...(retention.filesystem === "expires" ? { expiresAt: retention.expiresAt as string } : {}),
  })
  return Object.freeze({
    reference: Object.freeze({
      version: 1,
      operationId: expected.operationId,
      installationId: expected.installationId,
      threadId: expected.threadId,
      intentDigest: expected.digest,
      resource: resource(ref.resource),
    }),
    provenance: Object.freeze({
      sourceDigest: expected.sourceDigest,
      environment: env,
      retention: validatedRetention,
      ...(expected.baseline ? { baselineCommit: provenance.baselineCommit as string } : {}),
    }),
  })
}

/** Validate untrusted provider inspection output before persisting lifecycle state. */
export function verifyCreationStatus(
  value: unknown,
  intent: WorkspaceCreateIntent,
): CreationStatus {
  const expected = verifyWorkspaceIntent(intent)
  // Inspect the discriminator only after rejecting accessors and exotic records.
  const input = shape(value, ["status"], ["workspace", "reason", "resourcesRemain"])
  switch (input.status) {
    case "absent":
    case "pending":
      shape(input, ["status"])
      return Object.freeze({ status: input.status })
    case "ready":
      shape(input, ["status", "workspace"])
      return Object.freeze({
        status: "ready",
        workspace: verifyReadyWorkspace(input.workspace, expected),
      })
    case "unknown":
      shape(input, ["status", "reason"])
      return Object.freeze({ status: "unknown", reason: text(input.reason, 4096) })
    case "failed": {
      shape(input, ["status", "reason", "resourcesRemain"])
      const reason = shape(input.reason, ["code", "message"])
      if (
        typeof reason.code !== "string" ||
        !["lost", "expired", "conflict", "unsupported", "retryable", "uncertain"].includes(
          reason.code,
        )
      )
        throw new Error("Invalid workspace failure code")
      if (typeof input.resourcesRemain !== "boolean")
        throw new Error("Invalid workspace remaining resources flag")
      return Object.freeze({
        status: "failed",
        reason: Object.freeze({
          code: reason.code as WorkspaceLifecycleErrorCode,
          message: text(reason.message, 4096),
        }),
        resourcesRemain: input.resourcesRemain,
      })
    }
    default:
      throw new Error("Unsupported workspace creation status")
  }
}
