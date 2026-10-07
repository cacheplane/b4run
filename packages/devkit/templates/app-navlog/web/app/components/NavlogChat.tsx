"use client"
import type { Message } from "@ag-ui/client"
import { useB4ActivityContext, useB4ChatSlots } from "@b4run/ag-ui/copilotkit"
import { CopilotChat, useAgent } from "@copilotkit/react-core/v2"
import { useCallback } from "react"
import { stripToolEchoes } from "../lib/assistant-text"
import { isAwaitingApproval } from "../lib/navlog-selectors"

/**
 * The image types the chat attaches: the ones OpenAI's vision input takes.
 * The adapter has no image MIME gate of its own, so an `.svg` or `.heic` sent
 * from here would reach the provider and come back as a 400.
 */
export const ATTACHABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const

/**
 * Per attachment. Every turn sends the WHOLE history over `/agui`, whose body
 * limit is 8 MiB, so one large image would make every later turn fail; base64
 * also grows the bytes by a third.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

/**
 * Removes the plumbing a model echoes into its prose (`stripToolEchoes`) from
 * every assistant message with string content. Returns the input array when
 * nothing changed, so CopilotChat's memoized rows keep their identity.
 */
export function stripEchoMessages(messages: Message[]): Message[] {
  let changed = false
  const out = messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content !== "string") return message
    const content = stripToolEchoes(message.content)
    if (content === message.content) return message
    changed = true
    return { ...message, content }
  })
  return changed ? out : messages
}

export interface NavlogChatProps {
  readonly threadId: string
  /** Whether the route's model takes an image (`multimodal.input.image` in its capability document). */
  readonly canAttachImages: boolean
  readonly className?: string
}

/**
 * The chat dock's conversation: CopilotKit's stock `CopilotChat` with B4.run's
 * activity slots (one `TurnActivity` per turn), echo-free prose, named input
 * controls, image attachments when the model takes them, and an input that
 * waits while an approval is open. Render inside `B4Activity`.
 */
export function NavlogChat({ threadId, canAttachImages, className }: NavlogChatProps) {
  const slots = useB4ChatSlots()
  const { turns } = useB4ActivityContext()
  const { agent } = useAgent()
  const awaiting = isAwaitingApproval(turns)
  const running = agent.isRunning
  const merge = slots.messageView.transformMessages
  // CopilotChat memoizes the message list on this function: keep it stable.
  const transformMessages = useCallback((m: Message[]) => stripEchoMessages(merge(m)), [merge])
  return (
    <CopilotChat
      threadId={threadId}
      messageView={{ ...slots.messageView, transformMessages }}
      input={{
        textArea: {
          "aria-label": "Message",
          disabled: awaiting,
          placeholder: awaiting ? "Answer the approval above to continue" : "Ask the planner…",
        },
        // One button toggles between send and stop; name it for what it does now.
        // While an approval is open, text typed before it arrived must not go out.
        sendButton: {
          "aria-label": running ? "Stop" : "Send",
          ...(awaiting && !running ? { disabled: true } : {}),
        },
        addMenuButton: { "aria-label": "Add attachments" },
      }}
      scrollView={{ scrollToBottomButton: { "aria-label": "Jump to latest" } }}
      attachments={{
        enabled: canAttachImages,
        accept: ATTACHABLE_IMAGE_TYPES.join(","),
        maxSize: MAX_ATTACHMENT_BYTES,
      }}
      labels={{ chatDisclaimerText: "" }}
      className={className ?? "min-h-0 flex-1"}
    />
  )
}
