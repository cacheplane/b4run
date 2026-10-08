import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2"
import type { ReactElement } from "react"
import { turnForToolCalls } from "../../view/activity-lookup.js"
import { TurnActivity } from "../activity/TurnActivity.js"
import { useB4ActivityContext } from "./B4Activity.js"
import { mergeTurnMessages } from "./messages.js"

function B4ToolCallsView({
  message,
}: {
  readonly message: { readonly toolCalls?: ReadonlyArray<{ readonly id: string }> | undefined }
}): ReactElement | null {
  const { turns, labels, renderStep, now } = useB4ActivityContext()
  const ids = message.toolCalls?.map((c) => c.id) ?? []
  if (ids.length === 0) return null
  const turn = turnForToolCalls(turns, ids)
  return turn ? (
    <TurnActivity turn={turn} labels={labels} renderStep={renderStep} now={now} />
  ) : null
}

// B4.run sets `parentMessageId` on every `TOOL_CALL_START` (the model message
// that announced the call), so CopilotKit files an invocation's text and its
// calls in one assistant message. `mergeTurnMessages` moves every call of a
// turn onto that turn's first calling message — text or not — so one message
// per turn renders `TurnActivity`, after its text when it has some.
const hasText = (content: unknown): boolean =>
  (typeof content === "string" && content.trim() !== "") ||
  (Array.isArray(content) &&
    content.some((p) => {
      const part = p as { type?: unknown; text?: unknown }
      return (
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim() !== ""
      )
    }))

// `SlotValue<typeof CopilotChatAssistantMessage>` requires the component's
// namespace statics; Object.assign copies them onto the wrapper (spike finding).
const B4AssistantMessage = Object.assign(function B4AssistantMessage(
  props: CopilotChatAssistantMessageProps,
) {
  return (
    <CopilotChatAssistantMessage
      {...props}
      toolbarVisible={hasText(props.message.content)}
      toolCallsView={B4ToolCallsView}
    />
  )
}, CopilotChatAssistantMessage)

export interface B4ChatSlots {
  readonly messageView: {
    readonly transformMessages: typeof mergeTurnMessages
    readonly assistantMessage: typeof B4AssistantMessage
  }
}

const SLOTS: B4ChatSlots = {
  messageView: { transformMessages: mergeTurnMessages, assistantMessage: B4AssistantMessage },
}

/**
 * Props to spread onto `<CopilotChat>` inside `<B4Activity>`: one tool row per
 * turn, rendered as `TurnActivity`; no toolbar under tool-only rows. The slot
 * objects are module-level constants, so the slot identity never changes; the
 * turns reach the components through `B4Activity`'s context.
 *
 * ```tsx
 * <B4Activity><Chat /></B4Activity>
 * function Chat() { return <CopilotChat {...useB4ChatSlots()} /> }
 * ```
 */
export function useB4ChatSlots(): B4ChatSlots {
  useB4ActivityContext() // fail fast outside the provider
  return SLOTS
}
