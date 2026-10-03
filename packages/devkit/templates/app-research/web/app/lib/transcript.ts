/**
 * Turning `agent.messages` into the list the transcript renders.
 *
 * This is deliberately a pure module with no React and no CopilotKit import:
 * the pairing rules below (an assistant message can carry text AND tool calls,
 * a tool result lives in a *separate* message that has to be matched back by
 * `toolCallId`) are the only real logic in the transcript, and a hook-free
 * function is the only way to test them without a live agent.
 *
 * The message shapes are declared structurally rather than imported from
 * `@ag-ui/core`. That keeps this pure transcript module decoupled from the
 * transport package while the union below remains a supertype of the real
 * message shape. Verified against
 * `MessageSchema` in `@ag-ui/core`: the seven roles are user, assistant, tool,
 * activity, reasoning, system and developer.
 */

import type { B4ContentPart } from "@b4run/sdk"
import { mediaParts, partsOf } from "./parts.js"

/** As published in `ToolCallSchema` — args arrive as a JSON *string*. */
export interface TranscriptToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

/** A tool result. Structurally the `ToolMessage` `useRenderToolCall` wants. */
export interface ToolResultMessage {
  readonly id: string
  readonly role: "tool"
  /**
   * AG-UI 1.0 widens tool content to `string | ContentPart[]`. Typed `unknown`
   * so this union stays a supertype of the installed client's `Message`;
   * `toolResultText` below does the narrowing.
   */
  readonly content: unknown
  readonly toolCallId: string
  /**
   * Set by `buildTranscriptItems` (never by the transport) when the content
   * carries media: the result's parts in order, text included, for the
   * transcript to draw beside the tool card.
   */
  readonly parts?: readonly B4ContentPart[]
}

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
  readonly parts: readonly DroppedPartLike[]
}

export type TranscriptMessage =
  /**
   * `content` is `string | Array<{type:"text",text} | {type:"image",…}>`, and
   * the array form appears with attachments. Typed `unknown` so the union
   * stays a supertype of both installed copies; `userText` and `partsOf` do
   * the narrowing.
   */
  | { readonly id: string; readonly role: "user"; readonly content: unknown }
  | {
      readonly id: string
      readonly role: "assistant"
      readonly content?: string | undefined
      readonly toolCalls?: readonly TranscriptToolCall[] | undefined
    }
  | ToolResultMessage
  | {
      readonly id: string
      readonly role: "activity"
      readonly activityType: string
      readonly content: Record<string, unknown>
    }
  | {
      readonly id: string
      readonly role: "reasoning" | "system" | "developer"
      readonly content: string
    }

export type TranscriptItem =
  | {
      readonly kind: "user"
      readonly id: string
      readonly text: string
      /** Present only when the message carries media: all its parts, text included, in order. */
      readonly parts?: readonly B4ContentPart[]
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
  | {
      readonly kind: "activity"
      readonly id: string
      readonly activityType: string
      readonly content: Record<string, unknown>
    }
  | {
      readonly kind: "toolCall"
      readonly id: string
      readonly toolCall: TranscriptToolCall
      readonly toolResult?: ToolResultMessage
    }
  | {
      /** Parts the model never saw. Placed after the tool call or user turn they came from. */
      readonly kind: "notice"
      readonly id: string
      readonly toolCallId?: string
      readonly parts: readonly DroppedPartLike[]
    }

/**
 * A tool result's displayable text. Same rule as a user message: a string is
 * itself, a part list contributes its text parts in order, and media parts
 * contribute nothing here (they travel separately as `toolResult.parts`).
 */
export function toolResultText(content: unknown): string {
  return userText(content)
}

/**
 * A user message's displayable text. Multimodal content is an array of parts;
 * everything that is not a `text` part (an image, say) has no text to show, so
 * it contributes nothing rather than `[object Object]`.
 */
export function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
    })
    .join("")
}

/**
 * Flattens the message list into render-order items.
 *
 * - An assistant message yields its text (when non-empty) and then one item per
 *   tool call, in the order the model emitted them.
 * - A `role:"tool"` message is NOT an item of its own: it is folded into the
 *   tool-call item it answers, because that is the pairing
 *   `useRenderToolCall({ toolCall, toolMessage })` expects. Tool results are
 *   indexed up-front, so a result that arrives before its call (it shouldn't,
 *   but the transport does not guarantee it) still pairs.
 * - System and developer messages are dropped: they are prompt plumbing, and
 *   showing them in a transcript would leak instructions into the UI.
 * - A user message or tool result whose content carries media gets `parts`;
 *   a string or a text-only list does not, so it renders exactly as before.
 *   A user message is dropped only when it has neither text nor media.
 * - Each drop notice (the `b4.content_parts_dropped` events the shell
 *   collected, in arrival order) becomes a `notice` item: after the tool call
 *   it names, or — with no `toolCallId`, so the user's own message — after the
 *   newest user item. The event carries no message id, so a user-turn notice
 *   is anchored to the turn that was newest when it arrived only while that
 *   turn is still the newest. A notice with nothing to anchor to is appended.
 */
export function buildTranscriptItems(
  messages: readonly TranscriptMessage[],
  notices: readonly DropNotice[] = [],
): readonly TranscriptItem[] {
  const resultsByToolCallId = new Map<string, ToolResultMessage>()
  for (const message of messages) {
    if (message.role === "tool") {
      const parts = partsOf(message.content)
      resultsByToolCallId.set(
        message.toolCallId,
        mediaParts(parts).length > 0 ? { ...message, parts } : message,
      )
    }
  }

  const items: TranscriptItem[] = []
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = userText(message.content)
        const parts = partsOf(message.content)
        if (mediaParts(parts).length > 0) items.push({ kind: "user", id: message.id, text, parts })
        else if (text.length > 0) items.push({ kind: "user", id: message.id, text })
        break
      }
      case "assistant": {
        const text = message.content ?? ""
        if (text.length > 0) items.push({ kind: "assistant", id: message.id, text })
        for (const toolCall of message.toolCalls ?? []) {
          const toolResult = resultsByToolCallId.get(toolCall.id)
          items.push({
            kind: "toolCall",
            id: toolCall.id,
            toolCall,
            ...(toolResult ? { toolResult } : {}),
          })
        }
        break
      }
      case "activity":
        items.push({
          kind: "activity",
          id: message.id,
          activityType: message.activityType,
          content: message.content,
        })
        break
      case "reasoning": {
        if (message.content.length > 0) {
          items.push({ kind: "reasoning", id: message.id, text: message.content })
        }
        break
      }
      default:
        break
    }
  }
  return withNotices(items, notices)
}

function withNotices(
  items: readonly TranscriptItem[],
  notices: readonly DropNotice[],
): readonly TranscriptItem[] {
  if (notices.length === 0) return items
  const afterToolCall = new Map<string, TranscriptItem[]>()
  const afterUser: TranscriptItem[] = []
  const unanchored: TranscriptItem[] = []
  const toolCallIds = new Set(items.flatMap((item) => (item.kind === "toolCall" ? [item.id] : [])))
  let lastUserIndex = -1
  for (const [index, item] of items.entries()) if (item.kind === "user") lastUserIndex = index

  for (const [index, notice] of notices.entries()) {
    const item: TranscriptItem = {
      kind: "notice",
      id: `notice-${index}`,
      ...(notice.toolCallId !== undefined ? { toolCallId: notice.toolCallId } : {}),
      parts: notice.parts,
    }
    if (notice.toolCallId !== undefined) {
      if (toolCallIds.has(notice.toolCallId)) {
        const list = afterToolCall.get(notice.toolCallId) ?? []
        list.push(item)
        afterToolCall.set(notice.toolCallId, list)
      } else unanchored.push(item)
    } else if (lastUserIndex >= 0) afterUser.push(item)
    else unanchored.push(item)
  }

  const merged: TranscriptItem[] = []
  for (const [index, item] of items.entries()) {
    merged.push(item)
    if (item.kind === "toolCall") merged.push(...(afterToolCall.get(item.id) ?? []))
    if (index === lastUserIndex) merged.push(...afterUser)
  }
  merged.push(...unanchored)
  return merged
}
