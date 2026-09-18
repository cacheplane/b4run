import { candidateDigest, DigestInputError } from "../domain/digest.js"

export type AssemblyRule = "inventory" | "immutable" | "added" | "removed" | "cap" | "encoding"

/** A refusal the controller records as `scope_violation`, with the rule that fired. */
export class AssemblyRejectedError extends Error {
  constructor(
    readonly rule: AssemblyRule,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "AssemblyRejectedError"
  }
}

export interface AssemblyPolicy {
  readonly workspaceId: string
  readonly baselineDigest: string
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  readonly maxChangedBytes: number
}

export interface AssembledCandidate {
  readonly digest: string
  readonly changes: Readonly<Record<string, string>>
  readonly changedPaths: readonly string[]
  readonly bytes: number
}

/**
 * Diff what the builder left against the baseline the controller captured, and
 * enforce the policy before anything else happens. Nothing here trusts the
 * builder: the baseline, the inventory and the cap all come from the controller.
 */
export function assembleCandidate(input: {
  readonly baseline: ReadonlyMap<string, string>
  readonly observed: ReadonlyMap<string, string>
  readonly policy: AssemblyPolicy
}): AssembledCandidate {
  const { baseline, observed, policy } = input
  const allowed = new Set(policy.allowedSourcePaths)
  const immutable = new Set(policy.immutablePaths)

  for (const path of observed.keys())
    if (!baseline.has(path))
      throw new AssemblyRejectedError("added", `Candidate added a path: ${path}`)
  for (const path of baseline.keys())
    if (!observed.has(path))
      throw new AssemblyRejectedError("removed", `Candidate removed a path: ${path}`)

  const changes: Record<string, string> = {}
  let bytes = 0
  for (const path of [...baseline.keys()].sort()) {
    const before = baseline.get(path) as string
    const after = observed.get(path) as string
    if (before === after) continue
    if (immutable.has(path))
      throw new AssemblyRejectedError("immutable", `Candidate changed an immutable path: ${path}`)
    if (!allowed.has(path))
      throw new AssemblyRejectedError("inventory", `Path is not in the allowed inventory: ${path}`)
    // Content the controller cannot represent is rejected as `encoding` from two
    // places: a NUL byte is checked directly here, and anything else the digest
    // cannot hash injectively (e.g. a lone surrogate) is caught below when the
    // digest is computed. Both surface as the same rule so the controller
    // records one reason regardless of which check caught it.
    if (after.includes("\0"))
      throw new AssemblyRejectedError("encoding", `Candidate wrote a NUL byte in ${path}`)
    changes[path] = after
    bytes += Buffer.byteLength(after)
  }

  if (bytes > policy.maxChangedBytes)
    throw new AssemblyRejectedError(
      "cap",
      `Candidate exceeds the byte cap: ${bytes} > ${policy.maxChangedBytes}`,
    )

  let digest: string
  try {
    digest = candidateDigest({
      workspaceId: policy.workspaceId,
      baselineDigest: policy.baselineDigest,
      changes,
    })
  } catch (error) {
    if (error instanceof DigestInputError) {
      throw new AssemblyRejectedError(
        "encoding",
        `Candidate contains content the controller cannot represent: ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }

  return {
    digest,
    changes,
    changedPaths: Object.keys(changes),
    bytes,
  }
}
