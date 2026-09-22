import { createHash } from "node:crypto"
import type {
  CapturedWorkspaceDefinition,
  WorkspaceDefinition,
  WorkspaceResolver,
} from "@b4run/workspace"
import {
  captureWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
} from "@b4run/workspace/node"

/** A static definition, captured at build time. Version 1 is unchanged so existing builds keep booting. */
export interface CapturedWorkspaceBuildArtifact {
  readonly version: 1
  readonly descriptorDigest: string
  readonly workspace: CapturedWorkspaceDefinition
}
/** A resolver: nothing to capture at build time. Boot verifies the config is still a resolver. */
export interface ResolverWorkspaceBuildArtifact {
  readonly version: 2
  readonly kind: "resolver"
}
export type WorkspaceBuildArtifact = CapturedWorkspaceBuildArtifact | ResolverWorkspaceBuildArtifact
function descriptorDigest(definition: WorkspaceDefinition): string {
  let entries = 0
  function canonical(value: unknown, depth = 0): unknown {
    if (++entries > 50_000 || depth > 8) throw new Error("Workspace descriptor exceeds limit")
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "string") {
      if (value.length > 1_048_576) throw new Error("Workspace descriptor string too large")
      return value
    }
    if (typeof value !== "object") throw new Error("Invalid workspace descriptor value")
    if (Array.isArray(value)) {
      if (value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1)
        throw new Error("Invalid workspace descriptor array")
      return Array.from({ length: value.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(value, String(index))
        if (!field || !("value" in field)) throw new Error("Invalid workspace descriptor array")
        return canonical(field.value, depth + 1)
      })
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("Invalid workspace descriptor object")
    const result: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value).sort((a, b) => (String(a) < String(b) ? -1 : 1))) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !field || !("value" in field) || !field.enumerable)
        throw new Error("Invalid workspace descriptor field")
      Object.defineProperty(result, key, {
        value: canonical(field.value, depth + 1),
        enumerable: true,
      })
    }
    return result
  }
  const encoded = JSON.stringify(canonical(definition))
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
    throw new Error("Workspace descriptor exceeds byte limit")
  return createHash("sha256").update(encoded).digest("hex")
}
export async function captureWorkspaceArtifact(
  appRoot: string,
  workspace: WorkspaceDefinition | WorkspaceResolver,
): Promise<WorkspaceBuildArtifact> {
  if (typeof workspace === "function") return Object.freeze({ version: 2, kind: "resolver" })
  const digest = descriptorDigest(workspace)
  const captured = await captureWorkspaceDefinition(appRoot, workspace)
  return Object.freeze({ version: 1, descriptorDigest: digest, workspace: captured })
}

/** Verify a static artifact against a static definition. A resolver artifact here means the config changed form. */
export function verifyWorkspaceArtifact(
  value: unknown,
  definition: WorkspaceDefinition,
): CapturedWorkspaceDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace build artifact; rebuild the app")
  const record = value as Record<string, unknown>
  if (record.version === 2) throw new Error("Workspace configuration changed; rebuild the app")
  if (
    Object.keys(record).sort().join(",") !== "descriptorDigest,version,workspace" ||
    record.version !== 1
  )
    throw new Error("Invalid workspace build artifact; rebuild the app")
  if (record.descriptorDigest !== descriptorDigest(definition))
    throw new Error("Workspace configuration changed; rebuild the app")
  return verifyCapturedWorkspaceDefinition(record.workspace)
}

/** Verify a resolver artifact. A static artifact here means the config changed form. */
export function verifyWorkspaceResolverArtifact(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace build artifact; rebuild the app")
  const record = value as Record<string, unknown>
  if (record.version === 1) throw new Error("Workspace configuration changed; rebuild the app")
  if (
    Object.keys(record).sort().join(",") !== "kind,version" ||
    record.version !== 2 ||
    record.kind !== "resolver"
  )
    throw new Error("Invalid workspace build artifact; rebuild the app")
}
