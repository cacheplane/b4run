import { createHash } from "node:crypto"

/**
 * Canonical JSON: objects are re-serialized with their keys in sorted order, at
 * every depth, so two processes that assembled the same value from different
 * code paths produce the same bytes. Arrays keep their order, because every
 * array this module hashes is sorted by its caller on a stated key.
 */
export function canon(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )
  const out: Record<string, unknown> = {}
  for (const [key, inner] of entries) out[key] = sortDeep(inner)
  return out
}

const digest = (domain: string, value: unknown): string =>
  createHash("sha256").update(domain).update(canon(value)).digest("hex")

export interface CandidateDigestInput {
  readonly workspaceId: string
  readonly baselineDigest: string
  readonly changes: Readonly<Record<string, string>>
}

/** Identity of the changed bytes against a specific captured baseline. */
export function candidateDigest(input: CandidateDigestInput): string {
  return digest("b4-factory-candidate-v1", {
    workspaceId: input.workspaceId,
    baselineDigest: input.baselineDigest,
    changes: input.changes,
  })
}

export interface BundleDigestInput {
  readonly repositoryId: string
  readonly baselineDigest: string
  readonly specificationDigest: string
  readonly policyDigest: string
  readonly environmentIdentity: string
  readonly candidateDigest: string
  readonly evidence: readonly { readonly id: string; readonly digest: string }[]
  readonly operation: "export-local"
  readonly destinationId: string
}

/**
 * Identity of everything approval authorizes. A policy or environment change
 * moves this digest even when the candidate bytes are identical, which is what
 * makes consent specific rather than approximate.
 */
export function bundleDigest(input: BundleDigestInput): string {
  return digest("b4-factory-bundle-v1", {
    ...input,
    evidence: [...input.evidence].sort((a, b) => (a.id < b.id ? -1 : 1)),
  })
}

/** Digest of a fixture's task text plus its acceptance ids, in sorted order. */
export function specificationDigest(taskText: string, acceptanceIds: readonly string[]): string {
  return digest("b4-factory-spec-v1", { taskText, acceptanceIds: [...acceptanceIds].sort() })
}

/** Digest of the completion policy: the checks and the inventory the builder may touch. */
export function policyDigest(input: {
  readonly checks: unknown
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
}): string {
  return digest("b4-factory-policy-v1", {
    checks: input.checks,
    allowedSourcePaths: [...input.allowedSourcePaths].sort(),
    immutablePaths: [...input.immutablePaths].sort(),
  })
}
