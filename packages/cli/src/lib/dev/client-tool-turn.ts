/**
 * Matching an AG-UI run's `role: "tool"` messages against the retained
 * client-tool-call record (cacheplane/b4run#743, Model A).
 *
 * A parked client tool call is invisible to the client: it saw a tool call and
 * an ordinary `RUN_FINISHED`, ran the tool, and now sends its ENTIRE history
 * again plus a `role: "tool"` message carrying the result. This function
 * decides what that run means. It is pure decision logic over the store and
 * the checkpoint's pending snapshot; the AG-UI handler acts on the result.
 *
 * Security invariant: a `toolCallId` is trusted only when it names a client
 * park pending in THIS thread's checkpoint AND an outstanding, unexpired
 * record on THIS thread. Any other tool message is ordinary resupplied history
 * and is ignored — never an error, never passed anywhere — because every
 * AG-UI client resends its history on every run. That includes a tool message
 * for an already-answered or voided record: it is history, not a replay.
 * Replay stays impossible because a park is resumed once and answered records
 * are never re-fed from the message; the resume value always comes from the
 * store.
 *
 * Precedence, when several apply:
 *   1. no client park pending              → `none`
 *   2. any client park unanswerable        → `abandon` / "unanswerable"
 *      (no resume key, a malformed envelope, a malformed snapshot, no record
 *      on this thread, a record for a different park, or a voided record)
 *   3. any client park's outstanding record expired → `abandon` / "expired"
 *   4. last message is a user message      → `abandon` / "new_user_message"
 *      — even when every client park is answered. A resume carries no new
 *      input, so resuming here would silently drop the user's new message
 *      (e.g. an earlier request stored the results and then crashed before
 *      resuming). The abandon closes each answered call with its stored
 *      result, so `abandonedToolCallIds` is empty when all were answered.
 *      For these calls the stub's post-interrupt code does not run; that is
 *      acceptable because the stub returns the result immediately after
 *      `interrupt()` and does nothing else.
 *   5. every client park answered          → `resume`
 *   6. otherwise                           → `partial`
 * Only a trailing `user` message counts as new input: a trailing assistant,
 * system or developer message falls through to `partial`.
 * Valid results are stored BEFORE the abandon decisions, so an abandon closes
 * each call the client did answer with its real result. An expired call's
 * late result is never stored.
 *
 * Expiry compares instants (`Date.parse`), not strings, so an `expiresAt` in
 * a different-but-valid ISO form still compares correctly. An `expiresAt`
 * that does not parse is treated as expired: fail closed.
 *
 * Never voids rows: the handler voids after it has closed the calls in the
 * checkpoint. Never throws for client-controlled input; store failures
 * propagate, and an invalid `now` (the server clock, never client input)
 * throws.
 */
import type { B4Message } from "@b4run/ag-ui"
import {
  ABANDONED_CLIENT_TOOL_RESULT,
  type ClientToolResumeValue,
  isClientToolCallEnvelope,
} from "@b4run/core"
import { type ClientToolCallRecord, type ClientToolCallStore, contentPartsText } from "@b4run/sdk"

import {
  isClientToolPark,
  type PendingInterrupt,
  type PendingInterruptSnapshot,
} from "./pending-interrupts.js"

export type ClientToolTurn =
  | { readonly mode: "none" }
  | {
      readonly mode: "partial"
      /** The client parks still awaiting a result, by provider tool-call id. */
      readonly pendingToolCallIds: readonly string[]
    }
  | {
      readonly mode: "resume"
      /** Keyed by each client park's LangGraph resumeKey. */
      readonly resume: Readonly<Record<string, ClientToolResumeValue>>
      /** Non-client pending parks, for the handler to resolve with the envelope's approvals. */
      readonly others: readonly PendingInterrupt[]
    }
  | {
      readonly mode: "abandon"
      /**
       * Every client park's call to close: unanswered ones get
       * ABANDONED_CLIENT_TOOL_RESULT, answered ones keep their result.
       */
      readonly calls: ReadonlyArray<{
        readonly toolCallId: string
        readonly toolName: string
        readonly result: string
      }>
      readonly abandonedToolCallIds: readonly string[]
      readonly reason: "new_user_message" | "expired" | "unanswerable"
    }

export type ClientToolAbandonReason = Extract<ClientToolTurn, { mode: "abandon" }>["reason"]

interface ClientPark {
  readonly park: PendingInterrupt
  /** `undefined` when the envelope is client-typed but missing its ids. */
  readonly toolCallId: string | undefined
  readonly envelopeName: string | undefined
}

export async function resolveClientToolTurn(options: {
  readonly store: ClientToolCallStore
  readonly threadId: string
  readonly pending: PendingInterruptSnapshot
  readonly messages: readonly B4Message[]
  readonly now: Date
}): Promise<ClientToolTurn> {
  const { store, threadId, pending, messages, now } = options
  if (Number.isNaN(now.getTime())) {
    throw new Error("resolveClientToolTurn: `now` is an invalid Date")
  }

  const clientParks: ClientPark[] = []
  const others: PendingInterrupt[] = []
  for (const park of pending.interrupts) {
    if (!isClientToolPark(park.value)) {
      others.push(park)
      continue
    }
    const envelope = isClientToolCallEnvelope(park.value) ? park.value : undefined
    const name = envelope?.name
    clientParks.push({
      park,
      toolCallId: envelope?.toolCallId,
      envelopeName: typeof name === "string" ? name : undefined,
    })
  }
  if (clientParks.length === 0) return { mode: "none" }

  const rowsBefore = await readRows(store, threadId)

  // A malformed snapshot cannot be addressed safely: fail closed.
  let unanswerable = pending.malformed
  let expired = false
  // Parks whose record may take this run's result: outstanding and unexpired.
  const answerable = new Set<string>()
  for (const { park, toolCallId } of clientParks) {
    const row = toolCallId === undefined ? undefined : rowsBefore.get(toolCallId)
    if (
      toolCallId === undefined ||
      park.resumeKey === null ||
      !row ||
      row.interruptId !== park.interruptId ||
      row.voidedAt !== null
    ) {
      unanswerable = true
      continue
    }
    if (row.answeredAt !== null) continue
    if (isClientToolCallExpired(row, now)) {
      expired = true
      continue
    }
    answerable.add(toolCallId)
  }

  const at = now.toISOString()
  for (const message of messages) {
    if (message.role !== "tool") continue
    const toolCallId = message.toolCallId
    if (typeof toolCallId !== "string" || !answerable.has(toolCallId)) continue
    // "already_answered" / "voided" / "missing" are history or a lost race:
    // ignored. A later duplicate message for the same call lands here too.
    await store.answer({ threadId, toolCallId, result: contentPartsText(message.content), at })
  }

  const rows = answerable.size > 0 ? await readRows(store, threadId) : rowsBefore
  const answeredResult = (toolCallId: string | undefined): string | undefined => {
    if (toolCallId === undefined) return undefined
    const row = rows.get(toolCallId)
    if (!row || row.answeredAt === null || row.voidedAt !== null) return undefined
    return typeof row.result === "string" ? row.result : undefined
  }

  const abandon = (reason: ClientToolAbandonReason): ClientToolTurn => {
    const calls: Array<{ toolCallId: string; toolName: string; result: string }> = []
    const abandonedToolCallIds: string[] = []
    for (const { toolCallId, envelopeName } of clientParks) {
      // A client-typed park with no toolCallId has no call to close by id;
      // the handler still sees it in the checkpoint.
      if (toolCallId === undefined) continue
      const result = answeredResult(toolCallId)
      if (result === undefined) abandonedToolCallIds.push(toolCallId)
      calls.push({
        toolCallId,
        toolName: rows.get(toolCallId)?.toolName ?? envelopeName ?? "",
        result: result ?? ABANDONED_CLIENT_TOOL_RESULT,
      })
    }
    return { mode: "abandon", calls, abandonedToolCallIds, reason }
  }

  if (unanswerable) return abandon("unanswerable")
  if (expired) return abandon("expired")
  if (messages.at(-1)?.role === "user") return abandon("new_user_message")

  const resume: Record<string, ClientToolResumeValue> = {}
  let allAnswered = true
  for (const { park, toolCallId } of clientParks) {
    const result = answeredResult(toolCallId)
    if (result === undefined || park.resumeKey === null) {
      allAnswered = false
      break
    }
    resume[park.resumeKey] = { clientToolResult: result }
  }
  if (allAnswered) return { mode: "resume", resume, others }
  return {
    mode: "partial",
    pendingToolCallIds: clientParks.flatMap(({ toolCallId }) =>
      toolCallId !== undefined && answeredResult(toolCallId) === undefined ? [toolCallId] : [],
    ),
  }
}

async function readRows(
  store: ClientToolCallStore,
  threadId: string,
): Promise<Map<string, ClientToolCallRecord>> {
  const rows = await store.listForThread(threadId)
  return new Map(rows.map((row) => [row.toolCallId, row]))
}

/** Whether an outstanding record has expired at `now`; an unparseable `expiresAt` counts as expired. */
export function isClientToolCallExpired(row: ClientToolCallRecord, now: Date): boolean {
  if (row.expiresAt === null) return false
  const expiresAt = Date.parse(row.expiresAt)
  if (Number.isNaN(expiresAt)) return true
  return expiresAt <= now.getTime()
}
