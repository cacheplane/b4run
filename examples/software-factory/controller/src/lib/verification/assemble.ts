import { candidateDigest, DigestInputError } from "../domain/digest.js"

export type AssemblyRule =
  | "inventory"
  | "immutable"
  | "added"
  | "removed"
  | "cap"
  | "encoding"
  | "elided"
  | "shrunk"

/**
 * A refusal, with the rule that fired. The controller records `encoding` as
 * `encoding_violation`, `elided` and `shrunk` as `candidate_rejected`, and every other rule
 * as `scope_violation`.
 */
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

/**
 * A line a model writes in place of text it did not reproduce: `... (file truncated,
 * unchanged)`, `// rest of the file unchanged`, `(unchanged)`. The first live run's builder
 * wrote the first of these at line 670 of a 3,644-line file it had rewritten whole.
 *
 * Two shapes. `... (truncated` is refused wherever it appears. Anything else only when the
 * line is essentially nothing BUT a placeholder, optionally commented: prose that happens to
 * say "unchanged)" is code, and the `cli` target has two such comments
 * (`execute-route-core.ts:1190`, `middleware-node.ts:104`). And only on lines the baseline
 * does not already contain.
 */
export const ELISION_ANYWHERE = /\.\.\.\s*\(\s*(?:file\s+)?truncated/i
export const ELISION_LINE =
  /^\s*(?:\/\/|\/\*|#|\*)?\s*(?:\.\.\.\s*)?(?:\(?(?:file\s+)?truncated|(?:the\s+)?rest of (?:the\s+)?file(?:\s+unchanged)?|\(?unchanged\)?)[\s.)*/]*$/i
const isElision = (line: string): boolean => ELISION_ANYWHERE.test(line) || ELISION_LINE.test(line)

/**
 * A changed file smaller than this fraction of its baseline is a file the builder did not
 * finish writing, not a repair. Only above `SHRINK_FLOOR_BYTES`: a small file halved by a
 * genuine fix is plausible, a large one is not.
 */
export const SHRINK_LIMIT = 0.5
export const SHRINK_FLOOR_BYTES = 1024

/**
 * Did the builder elide `after` instead of editing it? A cheap guard that runs before the
 * verification (which the live run's truncated file would have failed only after 24
 * minutes): the rule and the reason, or undefined when the file looks whole.
 */
export function elisionIn(
  before: string,
  after: string,
): { readonly rule: "elided" | "shrunk"; readonly detail: string } | undefined {
  const baselineLines = new Set(before.split("\n"))
  const lines = after.split("\n")
  for (const [index, line] of lines.entries())
    if (!baselineLines.has(line) && isElision(line))
      return {
        rule: "elided",
        detail: `line ${index + 1} is an elision placeholder: ${JSON.stringify(line.trim().slice(0, 120))}`,
      }
  const was = Buffer.byteLength(before)
  const now = Buffer.byteLength(after)
  if (was >= SHRINK_FLOOR_BYTES && now < was * SHRINK_LIMIT)
    return {
      rule: "shrunk",
      detail: `it shrank from ${was} to ${now} bytes, below half its baseline`,
    }
  return undefined
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
    // digest is computed. Both surface as the same rule, and the controller
    // records it as `encoding_violation` rather than as a scope violation: the
    // path was allowed, the bytes were not.
    if (after.includes("\0"))
      throw new AssemblyRejectedError("encoding", `Candidate wrote a NUL byte in ${path}`)
    // The builder elided the file: a placeholder where text was, or most of it gone. Refused
    // here, in seconds, rather than by a verification that can only fail on it.
    const elided = elisionIn(before, after)
    if (elided !== undefined)
      throw new AssemblyRejectedError(elided.rule, `The builder elided ${path}: ${elided.detail}`)
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
