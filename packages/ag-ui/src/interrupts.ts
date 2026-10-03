import type { Interrupt } from "@ag-ui/core"

/**
 * AG-UI's `Interrupt`, as B4.run emits it. The single-use approval grant,
 * when the runtime minted one, is at `metadata.grant` — and only there.
 * `metadata` is schema-defined on `Interrupt`, so it survives a 1.0 client's
 * enforcement stage; a top-level `grant` would be stripped with a warning
 * on every prompt.
 *
 * The grant is deliberately RE-READABLE: a client that reattaches after a
 * reload must be able to get it again. Single-use is a property of
 * CONSUMPTION, not of disclosure.
 */
export type B4AguiInterrupt = Interrupt

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
   * Read from the AG-UI entry's `metadata.grant`; see `fromAguiResume`.
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
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    metadata: env,
  }
}

/**
 * Map AG-UI resume entries to B4.run resume requests. Vocabulary-agnostic: the
 * consumer decides how a `{ status, payload }` becomes B4.run's per-interrupt
 * decision. We only guarantee `interruptId` survives.
 *
 * The approval grant is read from `metadata.grant`, the schema-defined channel
 * a 1.0 client leaves intact. `HttpAgent` strips unknown top-level keys from
 * the outgoing input, so a 1.0 client never sends a top-level `grant`; if one
 * arrives anyway it is ignored.
 */
export function fromAguiResume(
  resume: ReadonlyArray<{
    interruptId: string
    status: "resolved" | "cancelled"
    payload?: unknown
    metadata?: Readonly<Record<string, unknown>> | undefined
  }>,
): B4ResumeRequest[] {
  return resume.map((entry) => {
    const grant = entry.metadata?.grant
    return {
      interruptId: entry.interruptId,
      status: entry.status,
      ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
      // Forwarded only when it is a string: an opaque echo must not become a
      // channel for arbitrary JSON on its way to the grant check.
      ...(typeof grant === "string" ? { grant } : {}),
    }
  })
}
