/**
 * The resume-side half of approval grants: minting for a run, verifying on
 * resume, consuming exactly once, and voiding what the thread has moved past.
 *
 * Design: `docs/superpowers/specs/2026-09-18-approval-capability-design.md`
 * (cacheplane/b4run#738); contract and crypto: `@b4run/sdk`'s
 * `interrupt-grants.ts`; park site: `@b4run/core`'s `approval-grants.ts`;
 * motivation: cacheplane/b4run#736.
 *
 * Two layers, one axis each, composed as AND, in a fixed order:
 *
 *   `ThreadAccessPolicy` — **who** is this caller, may they touch this thread
 *   the grant            — **which** parked call is this, and is this the FIRST answer
 *
 * The grant is deliberately not bound to caller identity, and the policy is
 * deliberately never shown the grant value: verification happens AFTER the
 * gate, and a policy that authorized on a client-supplied, not-yet-verified
 * value would be authorizing on the attacker's input. See §4 of the design.
 *
 * Grant checks therefore never run before the access gate, or they become the
 * oracle that the ordering comment on the resume handler exists to prevent.
 */

import type {
  ApprovalGrantMinter,
  ApprovalGrantMode,
  InterruptGrantRecord,
  InterruptGrantStore,
} from "@b4run/sdk"
import {
  createApprovalGrant,
  hashApprovalGrant,
  isApprovalGrantShape,
  timingSafeHexEqual,
} from "@b4run/sdk"
import type { PendingInterrupt } from "./pending-interrupts.js"
import { createRequestErrorBody } from "./server-errors.js"

/**
 * Everything the request path needs to mint, verify and consume grants,
 * resolved once at boot.
 *
 * `store` is optional and `mode` is not: "grants are required but nothing can
 * record them" has to be representable, because it is a real misconfiguration
 * and it must fail closed rather than fall through to the pre-grant path.
 */
export interface ApprovalGrantRuntime {
  readonly mode: ApprovalGrantMode
  readonly store?: InterruptGrantStore
  readonly ttlMs?: number
}

/**
 * The minter for one run on one thread, or `undefined` when there is nothing
 * to mint with.
 *
 * Returning `undefined` rather than a no-op minter is the point: a no-op would
 * satisfy the park site's "is a minter present?" check and park a prompt with
 * no grant, which is exactly the hole the fail-closed rule exists to close.
 * Absence must stay visible all the way down.
 */
export function minterFor(
  grants: ApprovalGrantRuntime,
  threadId: string,
): ApprovalGrantMinter | undefined {
  if (grants.mode === "off" || !grants.store) return undefined
  return createApprovalGrantMinter({
    store: grants.store,
    threadId,
    ...(grants.ttlMs !== undefined ? { ttlMs: grants.ttlMs } : {}),
  })
}

/**
 * Build the per-run minter the runtime injects into `config.configurable`.
 *
 * Closed over the thread whose `POST /threads/:id/resume` will answer these
 * interrupts — NOT over whatever thread happens to be executing. That is this
 * implementation's answer to open question 3 (which thread owns a subagent
 * interrupt's grant): the owner is the thread the resume endpoint addresses,
 * because a grant nobody can present is not a capability. In practice the two
 * coincide — a subagent materializes as a child graph inside the parent's run,
 * so `interrupt()` in a subagent node reads the parent's ambient run config
 * and therefore the parent's minter — but stating the rule here means a future
 * out-of-process subagent cannot silently mint against a thread with no resume
 * endpoint.
 */
export function createApprovalGrantMinter(options: {
  readonly store: InterruptGrantStore
  readonly threadId: string
  /** Omitted means no TTL — a human approval may legitimately sit overnight. */
  readonly ttlMs?: number
  readonly now?: () => number
}): ApprovalGrantMinter {
  const now = options.now ?? Date.now
  return {
    async mint({ interruptId, checkpointNs }) {
      const { grant, tokenHash } = await createApprovalGrant()
      const issuedMs = now()
      await options.store.issue({
        threadId: options.threadId,
        interruptId,
        checkpointNs,
        tokenHash,
        issuedAt: new Date(issuedMs).toISOString(),
        expiresAt:
          options.ttlMs === undefined ? null : new Date(issuedMs + options.ttlMs).toISOString(),
        consumedAt: null,
        consumedDecision: null,
        voidedAt: null,
      })
      // The plaintext is returned exactly once, to the park site. The store
      // keeps only the hash.
      return grant
    },
  }
}

/** A refusal, ready to become an HTTP response. */
export interface GrantRejection {
  readonly status: 400 | 403 | 409
  readonly code:
    | "grant_required"
    | "grant_invalid"
    | "grant_consumed"
    | "grant_expired"
    | "grant_unavailable"
    | "stale_interrupt"
  readonly message: string
  readonly details?: Record<string, unknown>
}

/**
 * `403 grant_invalid` — the SAME status, code and message for "no such grant
 * row", "wrong grant", "malformed grant" and "grant for another thread".
 *
 * Deliberately indistinguishable. A caller who has already passed the thread
 * gate could otherwise use the difference to learn whether a guessed
 * `interruptId` names a real parked call, which is precisely the fact the
 * `/pending_interrupts` gate exists to protect. Do not add a `reason` field
 * here to make debugging easier; log server-side instead.
 */
const GRANT_INVALID: GrantRejection = {
  status: 403,
  code: "grant_invalid",
  message: "The approval grant is not valid for this parked call",
}

export type GrantCheck =
  | { readonly ok: true; readonly consumable: readonly ConsumableGrant[] }
  | { readonly ok: false; readonly rejection: GrantRejection }

/** One verified grant, held until the resume is actually about to be delivered. */
export interface ConsumableGrant {
  readonly interruptId: string
  readonly decision: string
}

/**
 * Verify every presented grant against the live parked set.
 *
 * Runs AFTER the thread-access gate and after the existing exact-set match, so
 * by here the caller is authorized and the resume entries are known to name
 * exactly the pending interrupts. Nothing is mutated: consumption is a
 * separate step, because the design's ordering is verify → consume → deliver
 * and a verification that also consumed could not be sequenced that way.
 */
export async function checkGrants(args: {
  readonly mode: ApprovalGrantMode
  readonly store: InterruptGrantStore | undefined
  readonly threadId: string
  readonly pending: readonly PendingInterrupt[]
  readonly entries: readonly {
    readonly interruptId: string
    readonly grant?: unknown
    readonly decision: string
  }[]
  readonly now?: () => number
}): Promise<GrantCheck> {
  if (args.mode === "off") return { ok: true, consumable: [] }

  const store = args.store
  if (!store) {
    // Grants are switched on but nothing durable is wired. Under "required"
    // this is a misconfiguration and must not silently degrade to the old
    // path; under "optional" there can be no grant rows either, so every
    // interrupt is a pre-migration one and resumes as before.
    if (args.mode === "required") {
      return {
        ok: false,
        rejection: {
          status: 409,
          code: "grant_unavailable",
          message:
            'approvals.grants is "required" but no interrupt-grant store is configured for this runtime',
        },
      }
    }
    return { ok: true, consumable: [] }
  }

  const now = args.now ?? Date.now
  const consumable: ConsumableGrant[] = []
  const pendingIds = new Set(args.pending.map((entry) => entry.interruptId))

  for (const entry of args.entries) {
    // Defence in depth: the caller already matched the set, but a grant must
    // never be checked against an interrupt that is not actually parked.
    if (!pendingIds.has(entry.interruptId)) return { ok: false, rejection: GRANT_INVALID }

    const record = await store.get(args.threadId, entry.interruptId)

    if (!record) {
      // No grant row. Under "required" the prompt predates the migration (or
      // was parked while the mode was weaker) and cannot be retrofitted:
      // minting a grant now would mint it for a prompt already disclosed to
      // whoever saw it, which proves nothing. Tell the operator to re-park.
      if (args.mode === "required") {
        return {
          ok: false,
          rejection: {
            status: 409,
            code: "grant_unavailable",
            message:
              "This interrupt was parked without an approval grant and cannot be resumed under " +
              'approvals.grants: "required". Re-park the prompt.',
          },
        }
      }
      // "optional": an interrupt with no grant row resumes exactly as before.
      // The softness is per-interrupt-age, never per-request — which is why
      // the presence of a row below makes the grant mandatory.
      continue
    }

    // From here the interrupt HAS a grant, so the grant is required regardless
    // of mode. Without this rule "optional" would be a bypass: omit the grant,
    // get the old path.
    if (!isApprovalGrantShape(entry.grant)) {
      if (entry.grant === undefined && args.mode === "required") {
        return {
          ok: false,
          rejection: {
            status: 400,
            code: "grant_required",
            message: "This resume requires the approval grant the parked prompt carried",
          },
        }
      }
      return { ok: false, rejection: GRANT_INVALID }
    }

    if (!timingSafeHexEqual(await hashApprovalGrant(entry.grant), record.tokenHash)) {
      return { ok: false, rejection: GRANT_INVALID }
    }

    if (record.voidedAt !== null) {
      // The thread moved past this parked call. This is the staleness half of
      // #736, and the existing code is reused deliberately: to a client, a
      // voided grant and a vanished interrupt are the same event.
      return {
        ok: false,
        rejection: {
          status: 409,
          code: "stale_interrupt",
          message: "This approval was superseded before it was answered",
        },
      }
    }

    if (record.consumedAt !== null) {
      return { ok: false, rejection: alreadyConsumed(record) }
    }

    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= now()) {
      return {
        ok: false,
        rejection: {
          status: 409,
          code: "grant_expired",
          message: "This approval grant has expired",
        },
      }
    }

    consumable.push({ interruptId: entry.interruptId, decision: entry.decision })
  }

  return { ok: true, consumable }
}

/**
 * `409 grant_consumed`, echoing the recorded decision.
 *
 * The echo is the point: a double-submitting UI renders "already approved"
 * from it instead of re-prompting, and it is information the caller already
 * had (they made the decision). It is NOT re-executed.
 */
function alreadyConsumed(record: InterruptGrantRecord): GrantRejection {
  return {
    status: 409,
    code: "grant_consumed",
    message: "This approval has already been answered",
    details: {
      consumedAt: record.consumedAt,
      consumedDecision: record.consumedDecision,
    },
  }
}

/**
 * Consume every verified grant, atomically, immediately before the resume is
 * delivered to the graph.
 *
 * **Consume before execute.** A crash between this and delivery loses the
 * approval — the human is prompted again — rather than risking a double
 * application. That direction is chosen deliberately, and it is the honest
 * statement of what this buys: at-most-once DELIVERY, not exactly-once
 * EFFECT. An application whose tool half-applied a ledger write before
 * crashing is still half-applied, and its own idempotency key does not become
 * redundant.
 *
 * The decision passed here includes `deny` and `cancelled`: a denial IS a
 * decision, and a re-answerable denial is a replay surface of its own.
 */
export async function consumeGrants(args: {
  readonly store: InterruptGrantStore
  readonly threadId: string
  readonly consumable: readonly ConsumableGrant[]
  readonly now?: () => number
}): Promise<GrantRejection | undefined> {
  const at = new Date((args.now ?? Date.now)()).toISOString()
  for (const entry of args.consumable) {
    const result = await args.store.consume({
      threadId: args.threadId,
      interruptId: entry.interruptId,
      decision: entry.decision,
      at,
    })
    switch (result.outcome) {
      case "consumed":
        break
      case "already_consumed":
        // Lost the race with a concurrent resume that verified at the same
        // time. The conditional UPDATE's row count — not the earlier read —
        // is what decides the winner, which is why this is reachable and why
        // it must be treated as a refusal rather than a warning.
        return alreadyConsumed(result.record)
      case "voided":
        return {
          status: 409,
          code: "stale_interrupt",
          message: "This approval was superseded before it was answered",
        }
      case "missing":
        return GRANT_INVALID
    }
  }
  return undefined
}

/**
 * Void every outstanding grant for a thread whose parked call is no longer
 * pending — i.e. the thread moved on.
 *
 * This is what replaces a stored `checkpoint_id` in the design's binding
 * tuple. At the park site `config.configurable.checkpoint_id` is `undefined`
 * (the parked checkpoint has not been written yet) and `resume_key` does not
 * exist either (it is LangGraph's XXH3-128 of the checkpoint namespace,
 * computed when the write is persisted, by a hasher LangGraph does not
 * export), so neither could be recorded at mint time. Enforcing against the
 * LIVE pending set instead is strictly fresher than a copy of the checkpoint
 * id would have been, and it makes "the thread moved on" a fact B4 asserts
 * rather than a behavior it inherits from LangGraph advancing the checkpoint.
 *
 * Never allowed to fail a turn: voiding is a tightening, and a runtime that
 * refused to settle a turn because a bookkeeping UPDATE failed would trade a
 * replay window for an outage.
 */
export async function voidSupersededGrants(args: {
  readonly store?: InterruptGrantStore
  readonly threadId: string
  readonly stillPending: readonly string[]
  readonly now?: () => number
}): Promise<number> {
  if (!args.store) return 0
  try {
    return await args.store.voidOutstanding({
      threadId: args.threadId,
      keepInterruptIds: args.stillPending,
      at: new Date((args.now ?? Date.now)()).toISOString(),
    })
  } catch (error) {
    console.warn(`B4: could not void superseded approval grants for ${args.threadId}.`, error)
    return 0
  }
}

/**
 * The one place a {@link GrantRejection} becomes an HTTP response, so every
 * endpoint that checks grants answers identically. A second, hand-rolled
 * mapping somewhere else is how "403 for both" quietly becomes an oracle.
 */
export function grantRejectionResponse(rejection: GrantRejection): Response {
  return Response.json(
    createRequestErrorBody(rejection.message, {
      code: rejection.code,
      ...(rejection.details ?? {}),
    }),
    { status: rejection.status },
  )
}

/**
 * Verify, then consume, the grants for one resume — the whole grant half of
 * `POST /threads/:id/resume` and of the AG-UI resuming branch, in one call so
 * the two endpoints cannot drift apart.
 *
 * Must be called AFTER the thread-access gate and after `resolvePendingResume`.
 * Returns a ready-made refusal, or `undefined` to proceed.
 *
 * Consumption happens here, before the resume is delivered to the graph. A
 * crash in between loses the approval — the human is prompted again — rather
 * than risking a double application. At-most-once DELIVERY, not exactly-once
 * EFFECT.
 */
export async function gateResumeWithGrants(args: {
  readonly grants: ApprovalGrantRuntime
  readonly threadId: string
  readonly pending: readonly PendingInterrupt[]
  readonly entries: readonly {
    readonly interruptId: string
    readonly status: "resolved" | "cancelled"
    readonly payload?: unknown
    readonly grant?: unknown
  }[]
  readonly now?: () => number
}): Promise<Response | undefined> {
  if (args.grants.mode === "off") return undefined

  const check = await checkGrants({
    mode: args.grants.mode,
    store: args.grants.store,
    threadId: args.threadId,
    pending: args.pending,
    entries: args.entries.map((entry) => ({
      interruptId: entry.interruptId,
      ...(entry.grant !== undefined ? { grant: entry.grant } : {}),
      // A cancellation IS a decision, and a re-answerable denial is a replay
      // surface of its own — so `deny`/`cancelled` consumes the grant, per the
      // design's recommendation on open question 2.
      decision: entry.status === "cancelled" ? "deny" : String(entry.payload),
    })),
    ...(args.now ? { now: args.now } : {}),
  })
  if (!check.ok) return grantRejectionResponse(check.rejection)
  if (check.consumable.length === 0 || !args.grants.store) return undefined

  const failure = await consumeGrants({
    store: args.grants.store,
    threadId: args.threadId,
    consumable: check.consumable,
    ...(args.now ? { now: args.now } : {}),
  })
  return failure ? grantRejectionResponse(failure) : undefined
}
