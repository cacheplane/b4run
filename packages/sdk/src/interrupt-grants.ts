/**
 * Approval grants — a single-use capability bound to one parked tool call.
 *
 * Design: `docs/superpowers/specs/2026-09-18-approval-capability-design.md`
 * (cacheplane/b4run#738), motivated by cacheplane/b4run#736.
 *
 * The problem this solves is NOT disclosure — `ThreadAccessPolicy` already
 * answers *who may touch this thread*. It is **consumption**: inside a session
 * that legitimately holds the thread, nothing stopped the same approval being
 * answered twice (replay), or an approval minted against an earlier proposal
 * being applied to the current one (staleness).
 *
 * A grant is minted at the park site, in `@b4run/core`, and its plaintext is
 * carried by the interrupt envelope. Only its SHA-256 hash is written to the
 * grant store. On resume the client echoes the grant; the runtime hashes it,
 * compares in constant time, and consumes it with a conditional update. The
 * second resume with the same grant is refused rather than re-executed.
 *
 * Everything here is WebCrypto-only and has no Node built-in imports, because
 * `@b4run/sdk`'s main entry is loaded by the edge targets (`hono`, `vercel`).
 */

/**
 * How strictly the runtime requires a grant on resume. Configured as
 * `approvals.grants` in `b4.config.ts`.
 *
 * - `"off"` — grants are neither minted nor required. The pre-grant behavior,
 *   exactly. This is the default, and it is what every existing app gets.
 *
 *   A DELIBERATE deviation from the design (§6), which made `"off"` mint and
 *   disclose grants while never requiring them. Two reasons for the narrower
 *   reading: a mode called "off" that still opens a store and writes a row per
 *   park is not off, and an app that never enables the feature should not grow
 *   a database file. The cost, stated: flipping `"off"` → `"required"` strands
 *   prompts parked while it was off — they answer `409 grant_unavailable` and
 *   must be re-parked. Step through `"optional"` instead, which mints without
 *   requiring and is the migration window the design wanted `"off"` to be.
 * - `"optional"` — grants are minted and disclosed, and an interrupt that HAS
 *   a grant row REQUIRES its grant. An interrupt with no grant row — one
 *   parked before the migration, or while the mode was `"off"` — resumes as
 *   before. The softness is per-interrupt-age, not per-request: without that
 *   rule `"optional"` would be a bypass (omit the grant, get the old path).
 * - `"required"` — a resume with no grant is refused, and — the load-bearing
 *   half — a park with no way to mint a grant is refused too. See
 *   {@link ApprovalGrantMinter}.
 */
export type ApprovalGrantMode = "off" | "optional" | "required"

/** Every mode, for validation and for exhaustive iteration in tests. */
export const APPROVAL_GRANT_MODES: readonly ApprovalGrantMode[] = ["off", "optional", "required"]

export function isApprovalGrantMode(value: unknown): value is ApprovalGrantMode {
  return value === "off" || value === "optional" || value === "required"
}

/**
 * The key the per-run {@link ApprovalGrantMinter} travels under inside
 * LangGraph's `config.configurable`.
 *
 * This mirrors how the repo already injects live per-call identity — see the
 * `threadId` note on `B4ToolDefinition`'s run context, forwarded from
 * `config.configurable` by the langchain tool-converter. The park site reads
 * the ambient run config with `getConfig()` rather than taking a new
 * parameter, so nothing in core's call graph has to grow a storage handle.
 *
 * Double-underscored and non-enumerable-looking on purpose: it shares a
 * namespace with route params, which come from the URL. A route param cannot
 * be named this (`extractRouteParamNames` only yields identifier-shaped
 * names), and the park site type-checks what it finds before calling it.
 */
export const APPROVAL_GRANT_MINTER_KEY = "__b4ApprovalGrantMinter"

/**
 * Mints one grant for one park. Constructed per run by the layer that owns
 * storage (the CLI runtime), closed over the thread whose resume endpoint will
 * answer this interrupt, and injected into `config.configurable`.
 *
 * Injection through the run config is **optional by construction** — pre-wrap
 * and legacy invokers omit it, exactly as they omit `threadId`. That absence
 * must fail closed at the park site: under `"required"`, a park with no minter
 * is a loud runtime fault, never a park without a grant. The park site is the
 * one place that knows a grant is about to be needed, so it is the one place
 * that can refuse.
 */
export interface ApprovalGrantMinter {
  /**
   * Record a grant for `interruptId` and return its plaintext. The plaintext
   * is returned exactly once, to the park site; the store keeps only the hash.
   *
   * `checkpointNs` is LangGraph's namespace for the parked task, read from the
   * ambient run config. It is the preimage of the `resumeKey` the client sees
   * (LangGraph hashes it with XXH3-128 when it persists the write), so it is
   * the same binding to graph position expressed in the one encoding the park
   * site actually has. See the note on {@link InterruptGrantRecord.checkpointNs}.
   */
  mint(args: { readonly interruptId: string; readonly checkpointNs: string }): Promise<string>
}

/** A grant row as stored. Never carries the plaintext grant. */
export interface InterruptGrantRecord {
  readonly threadId: string
  readonly interruptId: string
  /**
   * LangGraph's checkpoint namespace for the parked task, verbatim.
   *
   * The design (§1) binds a grant to `(thread_id, interrupt_id, resume_key,
   * checkpoint_id)`. Two of those four do not exist at the park site: inside
   * the `interrupt()` throw, `config.configurable.checkpoint_id` is
   * `undefined` (the parked checkpoint has not been written yet) and
   * `resume_key` is LangGraph's XXH3-128 of this namespace, computed when the
   * write is persisted, by a hasher LangGraph does not export.
   *
   * So the binding is kept, and moved to where it can be enforced:
   * `checkpointNs` records the graph position the park site does know, and the
   * `resume_key`/`checkpoint_id` halves are enforced against the LIVE
   * checkpoint at resume time (the interrupt must still be pending) plus
   * {@link InterruptGrantStore.voidOutstanding} when the thread moves on.
   * The checkpoint is a strictly fresher authority than a copy of its id
   * would have been.
   */
  readonly checkpointNs: string
  /** Lowercase hex SHA-256 of the plaintext grant. Never the grant. */
  readonly tokenHash: string
  readonly issuedAt: string
  /** ISO-8601, or `null` for no TTL — a human approval may sit overnight. */
  readonly expiresAt: string | null
  readonly consumedAt: string | null
  /** `"once" | "always" | "deny"` when consumed, else `null`. */
  readonly consumedDecision: string | null
  readonly voidedAt: string | null
}

/**
 * The outcome of a conditional consume.
 *
 * `"consumed"` is the single-use point: it is decided by the row count of an
 * `UPDATE … WHERE consumed_at IS NULL AND voided_at IS NULL`, so it is atomic,
 * it survives a process restart, and it spans replicas — none of which the
 * in-process `createPendingResumeClaims` set does.
 */
export type InterruptGrantConsumption =
  | { readonly outcome: "consumed"; readonly record: InterruptGrantRecord }
  /** Someone already answered. Carries the recorded decision so a
   *  double-submitting UI can render "already approved" instead of re-prompting. */
  | { readonly outcome: "already_consumed"; readonly record: InterruptGrantRecord }
  | { readonly outcome: "voided"; readonly record: InterruptGrantRecord }
  | { readonly outcome: "missing" }

/**
 * Durable record of which parked approvals have been answered.
 *
 * Deliberately NOT the checkpointer's `writes` blob: that is LangGraph's, it
 * is returned to clients, and it is deleted on LangGraph's schedule rather
 * than ours — we would lose the consumption record at exactly the moment we
 * need it to answer a replay.
 */
export interface InterruptGrantStore {
  /** Write a new row. Fails if `(threadId, interruptId)` already exists. */
  issue(record: InterruptGrantRecord): Promise<void>
  get(threadId: string, interruptId: string): Promise<InterruptGrantRecord | undefined>
  /** Every row for a thread, consumed and voided ones included. */
  listForThread(threadId: string): Promise<readonly InterruptGrantRecord[]>
  /**
   * Conditionally consume. Atomic: the store decides the winner, never the
   * caller via a prior read.
   */
  consume(args: {
    readonly threadId: string
    readonly interruptId: string
    readonly decision: string
    readonly at: string
  }): Promise<InterruptGrantConsumption>
  /**
   * Stamp `voided_at` on every unconsumed, unvoided grant for `threadId`
   * whose `interruptId` is NOT in `keepInterruptIds` — i.e. every grant whose
   * parked call the thread has moved past. Returns how many were voided.
   *
   * This is the staleness half of #736, and it is what replaces a stored
   * `checkpoint_id`: "the thread moved on" becomes a fact B4 asserts rather
   * than a behavior it inherits from LangGraph advancing the checkpoint.
   */
  voidOutstanding(args: {
    readonly threadId: string
    readonly keepInterruptIds: readonly string[]
    readonly at: string
  }): Promise<number>
}

/** Grants are prefixed so one is recognizable in a log or a bug report. */
export const APPROVAL_GRANT_PREFIX = "b4ag_"

/** Bytes of randomness per grant. 32, per the design. */
export const APPROVAL_GRANT_BYTES = 32

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Hash a grant for storage and comparison. Lowercase hex SHA-256.
 *
 * Only the hash is stored, for the same reason a password is not stored: an
 * operator with read access to the database, or a leaked backup, must not
 * thereby be able to answer approval prompts.
 */
export async function hashApprovalGrant(grant: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grant))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** Mint one grant: 32 CSPRNG bytes, base64url, prefixed. Returns plaintext + hash. */
export async function createApprovalGrant(): Promise<{
  readonly grant: string
  readonly tokenHash: string
}> {
  const bytes = new Uint8Array(APPROVAL_GRANT_BYTES)
  crypto.getRandomValues(bytes)
  const grant = `${APPROVAL_GRANT_PREFIX}${base64Url(bytes)}`
  return { grant, tokenHash: await hashApprovalGrant(grant) }
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both operands are already SHA-256 outputs of fixed length, so this is belt
 * and braces rather than the load-bearing defense — but a byte-at-a-time
 * `===` on a secret-derived value is the kind of thing that gets copied, and
 * the fixed-length `||` accumulation costs nothing.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Shape check for a grant arriving on the wire, before it is hashed. */
export function isApprovalGrantShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(APPROVAL_GRANT_PREFIX) &&
    value.length > APPROVAL_GRANT_PREFIX.length &&
    value.length <= 128
  )
}

/**
 * In-process {@link InterruptGrantStore}. Not a mock: it enforces the same
 * atomicity the SQL stores do (single-threaded JS gives it for free) and
 * answers the same conformance suite. Used by the testing harness and by any
 * runtime with no durable store configured.
 */
export function createMemoryInterruptGrantStore(): InterruptGrantStore {
  const rows = new Map<string, InterruptGrantRecord>()
  const key = (threadId: string, interruptId: string) => `${threadId} ${interruptId}`

  return {
    async issue(record) {
      const k = key(record.threadId, record.interruptId)
      if (rows.has(k)) {
        throw new Error(
          `interrupt-grants: a grant already exists for (${record.threadId}, ${record.interruptId})`,
        )
      }
      rows.set(k, { ...record })
    },
    async get(threadId, interruptId) {
      const row = rows.get(key(threadId, interruptId))
      return row ? { ...row } : undefined
    },
    async listForThread(threadId) {
      return [...rows.values()]
        .filter((row) => row.threadId === threadId)
        .map((row) => ({ ...row }))
    },
    async consume({ threadId, interruptId, decision, at }) {
      const k = key(threadId, interruptId)
      const row = rows.get(k)
      if (!row) return { outcome: "missing" }
      if (row.voidedAt !== null) return { outcome: "voided", record: { ...row } }
      if (row.consumedAt !== null) return { outcome: "already_consumed", record: { ...row } }
      const next: InterruptGrantRecord = { ...row, consumedAt: at, consumedDecision: decision }
      rows.set(k, next)
      return { outcome: "consumed", record: { ...next } }
    },
    async voidOutstanding({ threadId, keepInterruptIds, at }) {
      const keep = new Set(keepInterruptIds)
      let voided = 0
      for (const [k, row] of rows) {
        if (row.threadId !== threadId) continue
        if (keep.has(row.interruptId)) continue
        if (row.consumedAt !== null || row.voidedAt !== null) continue
        rows.set(k, { ...row, voidedAt: at })
        voided++
      }
      return voided
    },
  }
}
