/**
 * The memory-candidate review surface, as data: the record shape the panel
 * reads and the pure readers for the three endpoint bodies.
 *
 * Three endpoints, and they are the whole surface (see `proxy-allowlist.ts`
 * — the proxy forwards these and nothing else):
 *
 * - `GET  /api/b4/memory/candidates`             -> `{ candidates }`
 * - `POST /api/b4/memory/candidates/:id/approve` -> `{ record, action, superseded }`
 * - `POST /api/b4/memory/candidates/:id/reject`  -> `{ ok: true }`
 *
 * Neither POST takes a body. Every body crosses the network as JSON, so each
 * reader checks the shape rather than casting it, and a body that fails reads
 * as "nothing to show" instead of throwing into the panel.
 */

/**
 * The fields of `MemoryRecord` (`packages/memory/src/types.ts`) the panel
 * reads, and only those.
 *
 * Deliberately a local, narrower type rather than the package's: this app
 * does not depend on `@b4run/memory` (the record arrives as JSON over the
 * proxy), and re-declaring the whole record here would be a second copy to
 * keep in sync for fields nothing renders.
 */
export interface MemoryCandidate {
  readonly id: string
  readonly content: string
  readonly namespace: string
  readonly tags?: readonly string[]
  readonly confidence?: number
}

/** What `POST …/approve` did, as the server reports it. */
export type ApproveAction = "activated" | "superseded" | "deduped"

/** The line an approve is worth, if any: "Replaced 1 earlier memory." / "… 2 earlier memories." */
export function describeApprove(action: ApproveAction, supersededCount: number): string | null {
  if (action === "deduped") return "Already remembered — nothing changed."
  if (action !== "superseded" || supersededCount === 0) {
    // A plain activation says nothing: the row disappearing from the list
    // is the feedback, and a line confirming what the click obviously
    // did is the kind of noise that makes a panel easy to stop reading.
    return null
  }
  const noun = supersededCount === 1 ? "memory" : "memories"
  return `Replaced ${supersededCount} earlier ${noun}.`
}

/**
 * The candidates out of a `GET /memory/candidates` body. Entries without a
 * string `id` and `content` are dropped: they could not be rendered or
 * decided on.
 */
export function readCandidates(body: unknown): readonly MemoryCandidate[] {
  const list = (body as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is MemoryCandidate =>
      typeof (entry as MemoryCandidate | null)?.id === "string" &&
      typeof (entry as MemoryCandidate).content === "string",
  )
}

/** The proxy's owner-only refusal message (`{ error: "owner_only", message }`), or null. */
export function readOwnerOnlyMessage(body: unknown): string | null {
  const parsed = body as { error?: unknown; message?: unknown } | null
  return parsed?.error === "owner_only" && typeof parsed.message === "string"
    ? parsed.message
    : null
}

/** The outcome line out of an approve response body (see `describeApprove`), or null. */
export function readApproveOutcome(body: unknown): string | null {
  const parsed = body as { action?: unknown; superseded?: unknown } | null
  const action = parsed?.action
  if (action !== "activated" && action !== "superseded" && action !== "deduped") return null
  const superseded = Array.isArray(parsed?.superseded) ? parsed.superseded.length : 0
  return describeApprove(action, superseded)
}
