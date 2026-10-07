"use client"

/**
 * One part the model did not see, as `DroppedPart` in
 * `packages/langchain/src/content-parts.ts` puts it on the wire.
 */
export interface DroppedPartLike {
  readonly index: number
  readonly type: string
  readonly source?: string
  readonly reason: string
}

/**
 * The value of a `CUSTOM` `b4.content_parts_dropped` event (`droppedPartsData`
 * in `packages/langchain/src/content-parts.ts`): `toolCallId` is set when the
 * parts came from a tool result, absent when they came from the user's own
 * message.
 */
export interface DropNotice {
  readonly provider?: string
  readonly model?: string
  readonly toolCallId?: string
  /**
   * Not on the wire: stamped by the shell when a user-turn notice (no
   * `toolCallId`) arrives — the id of the newest user message at that moment,
   * which is the turn whose parts were dropped.
   */
  readonly anchorMessageId?: string
  readonly parts: readonly DroppedPartLike[]
}

/**
 * The line a notice reads: how many parts the model never saw, and for each
 * its type and the reason the adapter gave (`DropReason` in
 * `packages/langchain/src/content-parts.ts`), verbatim — the reason codes are
 * what a developer greps for, and paraphrasing them would hide which one fired.
 */
export function dropNoticeText(parts: readonly DroppedPartLike[]): string {
  const count = parts.length
  const noun = count === 1 ? "content part was" : "content parts were"
  const list = parts.map((part) => `${part.type} (${part.reason})`).join(", ")
  return `${count} ${noun} not sent to the model: ${list}`
}

/**
 * The dock-level list of content-parts-dropped notices for the open thread.
 * Each is a quiet disclosure, not a line of prose: the pilot only needs to
 * know the planner could not see something (a chart image, say); the verbatim
 * reason codes stay one click away for a developer.
 */
export function DropNotices({ notices }: { readonly notices: readonly DropNotice[] }) {
  if (notices.length === 0) return null
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      {notices.map((notice, index) => (
        // Notices are append-only for the open thread and carry no id.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <details key={index} className="group text-[12px] leading-5 text-wb-muted">
          <summary className="wb-focus inline-flex cursor-pointer list-none items-center gap-1 rounded-wb-sm">
            <span aria-hidden="true">ⓘ</span>
            {notice.parts.length === 1
              ? "The planner could not see this content"
              : `The planner could not see ${notice.parts.length} items`}
          </summary>
          <p className="mt-1 font-mono text-[11px]">{dropNoticeText(notice.parts)}</p>
        </details>
      ))}
    </div>
  )
}
