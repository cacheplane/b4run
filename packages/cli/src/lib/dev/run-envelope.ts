/**
 * Structural validation of the AG-UI run envelope, and B4.run's stance on the
 * envelope fields a CLIENT can use to widen its own authority.
 *
 * Two different jobs, deliberately in one pass:
 *
 * 1. `threadId` / `runId` / `state` are B4.run's own wire format. AG-UI's
 *    `RunAgentInputSchema` types them (`string`, `string`, `any`) but does not
 *    bound them: `threadId: ""`, a whitespace-only `runId`, a megabyte-long id
 *    and `state: "nope"` all parse. Every app that cared had to re-check them
 *    by hand, and re-check them again each time the protocol grew a field.
 *
 * 2. `tools` and `forwardedProps` are not the app's inputs — they are the
 *    caller's attempt to add to what the ROUTE decided. A client that sends
 *    `tools: [...]` on a route whose tool set the server chose is asking for
 *    authority it was not given. Ignoring those fields is not enough: from
 *    outside, "ignored" and "honored" look identical, so a client cannot tell
 *    whether it just widened the run. They are therefore REJECTED unless the
 *    route named itself in `server.agui` — closed by default, opened on
 *    purpose.
 *
 * `resume` is not decided here. Whether a turn genuinely resumes is not a
 * property of the envelope: it depends on what is parked in the checkpointer,
 * which is only readable AFTER the thread-access policy has authorized the
 * caller to touch that thread. `resolvePendingResume` already rejects a resume
 * that matches no pending interrupt (`stale_interrupt`, 409) and a turn that
 * skipped a pending one (`resume_required`, 409); moving that judgment up here
 * would mean reading another caller's checkpoint before authorizing them.
 *
 * Pure: no `node:` imports, so the module is reachable from the edge bundle.
 */

import type { B4Config } from "@b4run/core"

/** Longest accepted `threadId`/`runId`. Long enough for a UUID, a ULID, or a namespaced id. */
export const MAX_ENVELOPE_ID_LENGTH = 256

/** What this ROUTE lets a client add to the envelope. Both closed unless configured. */
export interface RunEnvelopePolicy {
  readonly clientTools: boolean
  readonly forwardedProps: boolean
}

export type RunEnvelopeRejectionCode =
  | "invalid_envelope"
  | "invalid_thread_id"
  | "invalid_run_id"
  | "invalid_state"
  | "client_tools_not_allowed"
  | "forwarded_props_not_allowed"

export interface RunEnvelopeRejection {
  readonly code: RunEnvelopeRejectionCode
  readonly message: string
  readonly status: 422
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Exact match against an entry of a configured list; a non-array never names anything. */
function namesRoute(list: unknown, routeId: string): boolean {
  return Array.isArray(list) && list.some((entry) => entry === routeId)
}

/**
 * The route's stance, read off `server.agui`. Absent config, an absent section,
 * or a list that does not name this route all resolve to CLOSED — the default
 * has to be the safe one, because an app that never heard of this setting is
 * exactly the app that must not be honoring client tools.
 */
export function resolveRunEnvelopePolicy(
  config: B4Config | undefined,
  routeId: string,
): RunEnvelopePolicy {
  const agui = config?.server?.agui
  return {
    clientTools: namesRoute(agui?.clientTools, routeId),
    forwardedProps: namesRoute(agui?.clientForwardedProps, routeId),
  }
}

function invalidId(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "" || value.length > MAX_ENVELOPE_ID_LENGTH
}

/**
 * Validate one parsed request body against a route's policy.
 *
 * Runs against the ORIGINAL parsed JSON rather than the zod output, so what is
 * judged is what the client actually sent — `RunAgentInputSchema` strips
 * unknown keys and coerces `state`, and a check on its output would be a check
 * on B4.run's reading of the request instead of the request.
 *
 * Identity is checked before authority so a request that is malformed and
 * over-reaching is reported as malformed: the ids name the thread the other
 * checks are about.
 */
export function validateRunEnvelope(
  body: unknown,
  policy: RunEnvelopePolicy,
): RunEnvelopeRejection | undefined {
  if (!isRecord(body)) {
    return reject("invalid_envelope", "The run envelope must be a JSON object")
  }

  if (invalidId(body.threadId)) {
    return reject(
      "invalid_thread_id",
      `\`threadId\` must be a non-blank string of at most ${MAX_ENVELOPE_ID_LENGTH} characters`,
    )
  }
  if (invalidId(body.runId)) {
    return reject(
      "invalid_run_id",
      `\`runId\` must be a non-blank string of at most ${MAX_ENVELOPE_ID_LENGTH} characters`,
    )
  }
  // Absent is a turn that carries no state, which is ordinary. Present means a
  // state object — `null`, a string and an array are not one, and accepting
  // them would push the same ambiguity into every route's state merge.
  if (body.state !== undefined && !isRecord(body.state)) {
    return reject("invalid_state", "`state` must be a JSON object when present")
  }

  // An EMPTY `tools`/`forwardedProps` is what every AG-UI client sends when it
  // has nothing to add, so it is not an over-reach and stays accepted. Only a
  // non-empty one asks for anything, and only that needs the opt-in.
  const tools = body.tools
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      return reject("client_tools_not_allowed", "`tools` must be an array when present")
    }
    if (tools.length > 0 && !policy.clientTools) {
      return reject(
        "client_tools_not_allowed",
        "This route does not accept client-supplied `tools`. Name its route id in `server.agui.clientTools` in b4.config.ts to accept them.",
      )
    }
  }

  const forwardedProps = body.forwardedProps
  if (forwardedProps !== undefined) {
    if (!isRecord(forwardedProps)) {
      return reject(
        "forwarded_props_not_allowed",
        "`forwardedProps` must be a JSON object when present",
      )
    }
    if (Object.keys(forwardedProps).length > 0 && !policy.forwardedProps) {
      return reject(
        "forwarded_props_not_allowed",
        "This route does not accept client-supplied `forwardedProps`. Name its route id in `server.agui.clientForwardedProps` in b4.config.ts to accept them.",
      )
    }
  }

  return undefined
}

function reject(code: RunEnvelopeRejectionCode, message: string): RunEnvelopeRejection {
  return { code, message, status: 422 }
}
