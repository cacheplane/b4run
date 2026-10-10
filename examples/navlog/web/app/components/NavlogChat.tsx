"use client"
import type { Message } from "@ag-ui/client"
import { useB4ActivityContext, useB4ChatSlots } from "@b4run/ag-ui/react/copilotkit"
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
  CopilotChatView,
  type CopilotChatViewProps,
  useAgent,
} from "@copilotkit/react-core/v2"
import {
  type ComponentProps,
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { BriefRenderer } from "../brief/BriefRenderer"
import { type BriefActions, BriefActionsContext, BriefMarkdownContext } from "../brief/components"
import { stripToolEchoes } from "../lib/assistant-text"
import { isAwaitingApproval } from "../lib/navlog-selectors"
import { neutralButton } from "./ui"

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
    // A structured answer is JSON for the brief kit, not prose: leave it whole.
    if (message.content.trimStart().startsWith("{")) return message
    const content = stripToolEchoes(message.content)
    if (content === message.content) return message
    changed = true
    return { ...message, content }
  })
  return changed ? out : messages
}

/**
 * What `CopilotChat` reports when it refuses a file: a type outside `accept`,
 * a file over `maxSize`, or a read that failed. Taken from the prop itself so
 * it cannot drift from the installed CopilotKit.
 */
export type AttachmentFailure = Parameters<
  NonNullable<NonNullable<ComponentProps<typeof CopilotChat>["attachments"]>["onUploadFailed"]>
>[0]

/**
 * The line the dock shows for a refused file. CopilotKit's own `message`
 * lists the raw `accept` string and a byte-formatted limit; the pilot gets the
 * plain version instead.
 */
export function attachmentFailureText(failure: AttachmentFailure): string {
  switch (failure.reason) {
    case "file-too-large":
      return `${failure.file.name} is larger than 4 MB`
    case "invalid-type":
      return "Only PNG, JPEG, GIF or WebP images can be attached."
    default:
      return `Could not read ${failure.file.name}`
  }
}

/**
 * CopilotKit's own markdown, the look the chat has always had (Streamdown
 * inside the message's prose wrapper), for answers and `Prose` blocks.
 */
function ChatMarkdown({ content }: { readonly content: string }) {
  return <CopilotChatAssistantMessage.MarkdownRenderer content={content} />
}

/** The message whose answer is rendering, so its citation anchors are unique in the chat. */
const MessageIdContext = createContext("")

/**
 * The assistant message's `markdownRenderer` slot: the brief kit for a
 * structured answer, CopilotKit's markdown for anything else.
 */
function ChatAnswer({
  content,
}: ComponentProps<typeof CopilotChatAssistantMessage.MarkdownRenderer>) {
  const messageId = useContext(MessageIdContext)
  return (
    <BriefMarkdownContext.Provider value={ChatMarkdown}>
      <BriefRenderer content={content} idPrefix={`${messageId}-`} />
    </BriefMarkdownContext.Provider>
  )
}

/**
 * The activity kit's assistant message with the brief kit as its markdown
 * renderer. Module-level so the slot's identity never changes; the statics
 * (`MarkdownRenderer`, `Toolbar`, …) are copied on because CopilotKit's slot
 * type requires them.
 */
export const NavlogAssistantMessage = Object.assign(function NavlogAssistantMessage(
  props: CopilotChatAssistantMessageProps,
) {
  const B4AssistantMessage = useB4ChatSlots().messageView.assistantMessage
  return (
    <MessageIdContext.Provider value={props.message.id}>
      <B4AssistantMessage {...props} markdownRenderer={ChatAnswer} />
    </MessageIdContext.Provider>
  )
}, CopilotChatAssistantMessage)

/** How the brief's controls reach the composer: CopilotChat's own input setter, and the input's root. */
interface Composer {
  setValue: ((value: string) => void) | undefined
  root: HTMLElement | null
}

const ComposerContext = createContext<RefObject<Composer> | null>(null)

/**
 * CopilotChat's view, unchanged, except that it hands the chat its input
 * setter (`onInputChange`, the `setState` CopilotChat keeps the composer text
 * in) so a brief control can fill the composer.
 */
function NavlogChatView(props: CopilotChatViewProps) {
  const composer = useContext(ComposerContext)
  const root = useRef<HTMLDivElement>(null)
  const { onInputChange } = props
  useEffect(() => {
    if (composer === null) return
    composer.current = { setValue: onInputChange, root: root.current }
  }, [composer, onInputChange])
  return (
    <div ref={root} style={{ display: "contents" }}>
      <CopilotChatView {...props} />
    </div>
  )
}

/** The scroll view's slot: no inputs, so one object for the module's life. */
const SCROLL_VIEW = { scrollToBottomButton: { "aria-label": "Jump to latest" } }

export interface NavlogChatProps {
  readonly threadId: string
  /** Whether the route's model takes an image (`multimodal.input.image` in its capability document). */
  readonly canAttachImages: boolean
  readonly className?: string
}

/**
 * The chat dock's conversation: CopilotKit's stock `CopilotChat` with B4.run's
 * activity slots (one `TurnActivity` per turn), echo-free prose, named input
 * controls, image attachments when the model takes them (a refused file gets
 * one dismissible line above the conversation), and an input that waits while
 * an approval is open. Assistant answers render through the brief kit
 * (`NavlogAssistantMessage`), whose assumption "Change" fills the composer.
 * Render inside `B4Activity`.
 *
 * The send button's label reads `agent.isRunning`, the same flag `CopilotChat`
 * itself uses to swap the button to stop and to wire its stop handler — so
 * the name always says what a click does, including during a thread restore
 * (`connectAgent` holds `isRunning` for the replay, and a click then stops it).
 * The header's status badge uses a narrower rule; see `ThreadWorkbench`.
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
  const messageView = useMemo(
    () => ({ ...slots.messageView, assistantMessage: NavlogAssistantMessage, transformMessages }),
    [slots.messageView, transformMessages],
  )
  // An assumption's "Change" puts "Actually, <statement>" in the composer, focused,
  // cursor at the end, for the pilot to finish and send.
  const composer = useRef<Composer>({ setValue: undefined, root: null })
  const briefActions = useMemo<BriefActions>(
    () => ({
      changeAssumption: (statement) => {
        const text = `Actually, ${statement}`
        const { setValue, root } = composer.current
        setValue?.(text)
        requestAnimationFrame(() => {
          const textArea = root?.querySelector("textarea")
          if (!textArea) return
          textArea.focus()
          textArea.setSelectionRange(text.length, text.length)
        })
      },
    }),
    [],
  )
  // The last refused file, until dismissed or replaced by the next refusal.
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  // Memoized so a streamed token that changes neither flag hands CopilotChat
  // the same slot objects.
  const input = useMemo(
    () => ({
      textArea: {
        "aria-label": "Message",
        disabled: awaiting,
        placeholder: awaiting ? "Answer above first" : "Ask the planner…",
      },
      // One button toggles between send and stop; name it for what it does now.
      // While an approval is open, text typed before it arrived must not go out.
      sendButton: {
        "aria-label": running ? "Stop" : "Send",
        ...(awaiting && !running ? { disabled: true } : {}),
      },
      addMenuButton: { "aria-label": "Add attachments" },
    }),
    [awaiting, running],
  )
  const attachments = useMemo(
    () => ({
      enabled: canAttachImages,
      accept: ATTACHABLE_IMAGE_TYPES.join(","),
      maxSize: MAX_ATTACHMENT_BYTES,
      onUploadFailed: (failure: AttachmentFailure) =>
        setAttachNotice(attachmentFailureText(failure)),
    }),
    [canAttachImages],
  )
  return (
    <>
      {attachNotice === null ? null : (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 px-3 pt-2 text-[12px] leading-5 text-wb-muted"
        >
          <p className="min-w-0 flex-1">{attachNotice}</p>
          <button
            type="button"
            onClick={() => setAttachNotice(null)}
            className={`${neutralButton("sm")} shrink-0 pointer-coarse:min-h-11 pointer-coarse:px-4`}
          >
            Dismiss
          </button>
        </div>
      )}
      <ComposerContext.Provider value={composer}>
        <BriefActionsContext.Provider value={briefActions}>
          <CopilotChat
            threadId={threadId}
            chatView={NavlogChatView}
            messageView={messageView}
            input={input}
            scrollView={SCROLL_VIEW}
            attachments={attachments}
            labels={{ chatDisclaimerText: "" }}
            className={className ?? "min-h-0 flex-1"}
          />
        </BriefActionsContext.Provider>
      </ComposerContext.Provider>
    </>
  )
}
