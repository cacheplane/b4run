import { createHash } from "node:crypto"

/** Thrown when a value cannot be hashed injectively by {@link canon}. */
export class DigestInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DigestInputError"
  }
}

// A lone surrogate (a lead not followed by a trail, or a trail with no lead)
// has no valid UTF-8 encoding. Node's default utf8 string encoding silently
// replaces it with U+FFFD, so two distinct strings differing only in which
// lone surrogate they contain would otherwise hash identically.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Canonical JSON: objects are re-serialized with their keys in sorted order, at
 * every depth, so two processes that assembled the same value from different
 * code paths produce the same bytes. Arrays keep their order, because every
 * array this module hashes is sorted by its caller on a stated key.
 *
 * Contract: `canon` is injective over the values it accepts — two distinct
 * accepted values never produce the same output. `null` is accepted and
 * meaningful. Anything `canon` cannot represent faithfully (`undefined`,
 * functions, symbols, bigints, `NaN`/`Infinity`/`-Infinity`, strings
 * containing a lone surrogate, non-plain objects, and a literal `__proto__`
 * key) is rejected with a {@link DigestInputError} naming the offending path,
 * rather than silently coerced or dropped the way `JSON.stringify` would.
 * `canon` hashes own-enumerable-property structure only: a `Date`, `Map`,
 * `Set`, `RegExp`, or any other object whose state does not live in own
 * enumerable properties is rejected rather than serialized, and any `toJSON`
 * method it defines is deliberately ignored.
 */
export function canon(value: unknown): string {
  return JSON.stringify(sortDeep(value, ""))
}

function sortDeep(value: unknown, path: string): unknown {
  const at = path || "<root>"
  if (value === undefined) throw new DigestInputError(`Cannot hash undefined at "${at}"`)
  if (typeof value === "function") throw new DigestInputError(`Cannot hash a function at "${at}"`)
  if (typeof value === "symbol") throw new DigestInputError(`Cannot hash a symbol at "${at}"`)
  if (typeof value === "bigint") throw new DigestInputError(`Cannot hash a bigint at "${at}"`)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DigestInputError(`Cannot hash non-finite number ${value} at "${at}"`)
    }
    return value
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) {
      throw new DigestInputError(`Cannot hash a string containing a lone surrogate at "${at}"`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sortDeep(item, path ? `${path}[${index}]` : `[${index}]`))
  }
  if (value === null) return null
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown"
      throw new DigestInputError(`Cannot hash a non-plain object (${name}) at "${at}"`)
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )
    // Object.create(null) so assigning to a "__proto__" key (which JSON.parse
    // can legitimately produce as an own property) stores an ordinary data
    // property instead of invoking the Object.prototype setter and silently
    // mutating this accumulator's own prototype.
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, inner] of entries) {
      const keyPath = path ? `${path}.${key}` : key
      if (key === "__proto__") {
        throw new DigestInputError(`Cannot hash a "__proto__" key at "${keyPath}"`)
      }
      out[key] = sortDeep(inner, keyPath)
    }
    return out
  }
  return value
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
  /** The work order whose approval this bundle authorizes. */
  readonly workOrderId: string
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
 * makes consent specific rather than approximate. `workOrderId` is included for
 * the same reason: two work orders can produce byte-identical bundles (exactly
 * what a retried task does), and without it they would collide on this digest
 * even though the records must agree about which work order was delivered.
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

/** What the verifier ran in and what it ran over, bound into the policy. */
export interface PolicyEnvironment {
  /** `environmentIdentityDigest` of the target's image object. */
  readonly identity: string
  /** A full 40-hex commit sha in the target repository; defines the baseline bytes. */
  readonly pin: string
  /** Repository directory that is the workspace root; `.` is the repository itself. */
  readonly root: string
  /** Paths captured, relative to `root`. */
  readonly captureInclude: readonly string[]
  /** sha256 of `defect.patch`, or null when the pinned bytes are already the baseline. */
  readonly defectPatchSha256: string | null
}

/**
 * Digest of the completion policy: the checks, the inventory the builder may
 * touch, and the environment the verdict is earned in. `checks` must be a plain
 * object; `canon` validates its contents (see {@link DigestInputError}) so two
 * policies that differ only by an unrepresentable value — e.g. an `undefined`
 * field — cannot collide. The environment is included because a bundle frozen
 * over one baseline definition or one image must not be approvable after
 * either changed.
 */
export function policyDigest(input: {
  readonly checks: Readonly<Record<string, unknown>>
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  readonly environment: PolicyEnvironment
}): string {
  return digest("b4-factory-policy-v2", {
    checks: input.checks,
    allowedSourcePaths: [...input.allowedSourcePaths].sort(),
    immutablePaths: [...input.immutablePaths].sort(),
    environment: {
      identity: input.environment.identity,
      pin: input.environment.pin,
      root: input.environment.root,
      captureInclude: [...input.environment.captureInclude].sort(),
      defectPatchSha256: input.environment.defectPatchSha256,
    },
  })
}

/** The inputs that determined a target image, as the prepare script recorded them. */
export interface ImageInputs {
  readonly localId: string
  readonly platform: string
  readonly baseManifestDigest: string
  readonly dockerfileSha256: string
  readonly lockfileSha256: string
  readonly pnpmVersion: string
}

/**
 * The environment identity every receipt and bundle binds. A local Docker image
 * id alone is host-specific and unverifiable elsewhere; digesting it together
 * with the inputs that produced it lets a second host verify the inputs.
 */
export function environmentIdentityDigest(image: ImageInputs): string {
  return digest("b4-factory-environment-v1", {
    localId: image.localId,
    platform: image.platform,
    baseManifestDigest: image.baseManifestDigest,
    dockerfileSha256: image.dockerfileSha256,
    lockfileSha256: image.lockfileSha256,
    pnpmVersion: image.pnpmVersion,
  })
}
