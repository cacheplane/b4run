import type { Interrupt } from "@ag-ui/core"

/**
 * AG-UI's `Interrupt`, widened with the approval grant B4.run adds.
 *
 * Widened rather than pushed upstream because `InterruptSchema` is a closed,
 * `"strip"`-mode zod object: `grant` is a B4.run concept and a consumer that
 * re-validates through AG-UI's own schema will not see it. See the note in
 * `toAguiInterrupt`.
 */
export type B4AguiInterrupt = Interrupt & {
  /**
   * The single-use approval grant for this parked call, when the runtime
   * minted one. Echo it opaquely on the matching resume entry.
   *
   * Also present at `metadata.grant`, which is the copy that survives a
   * round trip through `InterruptSchema`.
   */
  readonly grant?: string
}

/**
 * The interrupt envelope B4.run's capabilities emit inside an `interrupt` chunk
 * (`entry.value` from LangGraph). Always carries `interruptId`; other keys are
 * capability-specific and preserved verbatim.
 */
export interface B4InterruptEnvelope {
  readonly interruptId: string
  readonly type?: string
  readonly kind?: string
  readonly callId?: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly message?: string
  readonly toolCallId?: string
  readonly [key: string]: unknown
}

/** A resume instruction addressed to one open B4.run interrupt. */
export interface B4ResumeRequest {
  readonly interruptId: string
  readonly status: "resolved" | "cancelled"
  readonly payload?: unknown
  /**
   * The single-use approval grant the parked prompt carried, echoed back
   * opaquely. The client never constructs it and authors nothing about the
   * decision beyond `status`/`payload`.
   *
   * Optional at the type level for migration only; required at runtime
   * whenever the interrupt has a grant. See
   * `docs/superpowers/specs/2026-09-18-approval-capability-design.md` §2.
   */
  readonly grant?: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Map a B4.run interrupt envelope to an AG-UI `Interrupt`. The full envelope is
 * preserved under `metadata` so no capability-specific information is lost on
 * the way to the client.
 */
export function toAguiInterrupt(data: unknown): B4AguiInterrupt | null {
  if (!isPlainRecord(data)) return null
  const interruptId = data.interruptId
  if (typeof interruptId !== "string" || interruptId.length === 0) {
    return null
  }
  const env = data
  const reason = typeof env.kind === "string" ? env.kind : "interrupt"
  // B4.run's envelopes name the model tool-call id of the `task`/tool call an
  // interrupt belongs to `callId` (see permission-gate.ts and
  // agent-adapter.ts's projectInterruptValue); AG-UI's `Interrupt` names the
  // same concept `toolCallId`. Prefer an explicit `toolCallId` if an envelope
  // ever carries one, else fall back to `callId` — this bridges the two
  // vocabularies so the orchestration ledger can settle on the right id.
  const toolCallId =
    typeof env.toolCallId === "string" && env.toolCallId.length > 0
      ? env.toolCallId
      : typeof env.callId === "string" && env.callId.length > 0
        ? env.callId
        : undefined
  // The single-use approval grant is ALSO surfaced as a top-level `grant`,
  // while staying in the verbatim `metadata` copy. Carrying it twice in one
  // object is not a second disclosure — it is the same already-gated payload —
  // and both copies are needed, for a reason worth writing down:
  //
  // The design (§2) asked for the grant top-level and NOT in `metadata`. That
  // is not expressible here. `Interrupt` is AG-UI's type, not B4.run's: it is
  // `z.infer<typeof InterruptSchema>` over a CLOSED zod object in `"strip"`
  // mode with no `grant` key, so any consumer that re-validates an interrupt
  // through `InterruptSchema` silently DROPS a top-level `grant` — which would
  // make the prompt unanswerable under `approvals.grants: "required"`, and
  // would do it quietly. `metadata` is `z.record(z.string(), z.any())` and
  // survives that round trip, so it is the only channel that always arrives.
  //
  // So: read `grant` if you have it, fall back to `metadata.grant`. The
  // top-level field is the ergonomic one; `metadata.grant` is the durable one.
  //
  // This is NOT single-use disclosure. The grant is deliberately RE-READABLE:
  // a client that reattaches after a reload must be able to get it again, and
  // reattach is a supported path (`GET /threads/:id/runs/stream`). Single-use
  // is a property of CONSUMPTION, not of disclosure.
  const grant = typeof env.grant === "string" && env.grant.length > 0 ? env.grant : undefined
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(grant !== undefined ? { grant } : {}),
    metadata: env,
  }
}

/**
 * Map AG-UI resume entries to B4.run resume requests. Vocabulary-agnostic: the
 * consumer decides how a `{ status, payload }` becomes B4.run's per-interrupt
 * decision. We only guarantee `interruptId` survives.
 */
export function fromAguiResume(
  resume: ReadonlyArray<{
    interruptId: string
    status: "resolved" | "cancelled"
    payload?: unknown
    grant?: unknown
  }>,
): B4ResumeRequest[] {
  return resume.map((entry) => ({
    interruptId: entry.interruptId,
    status: entry.status,
    ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
    // Forwarded only when it is a string: an opaque echo must not become a
    // channel for arbitrary JSON on its way to the grant check.
    ...(typeof entry.grant === "string" ? { grant: entry.grant } : {}),
  }))
}
