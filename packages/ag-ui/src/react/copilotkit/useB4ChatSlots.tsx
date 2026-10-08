import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
  CopilotChatReasoningMessage,
  type CopilotChatReasoningMessageProps,
} from "@copilotkit/react-core/v2"
import type { ReactElement } from "react"
import { turnForToolCalls } from "../../view/activity-lookup.js"
import type { StepView, TurnsView } from "../../view/turns.js"
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

/** Whether `steps` hold the reasoning span or message `id`, at any depth. */
function holdsReasoning(steps: readonly StepView[], id: string): boolean {
  return steps.some(
    (s) =>
      (s.kind === "reasoning" && (s.id === id || s.messageId === id)) ||
      (s.kind === "subagent" && holdsReasoning(s.turn.steps, id)),
  )
}

/**
 * Whether the reasoning message `id` already shows as a `ReasoningStep` in a
 * `TurnActivity`: its turn has a tool or subagent step, which is what gives a
 * turn its activity row (`turnForToolCalls`). A turn that only reasoned and
 * answered has no activity row, so its reasoning stays CopilotKit's.
 */
function reasoningInActivity(turns: TurnsView, id: string): boolean {
  const turn = turns.turns.find((t) => holdsReasoning(t.steps, id))
  return turn?.steps.some((s) => s.kind === "tool" || s.kind === "subagent") ?? false
}

// CopilotKit renders each reasoning message on its own row; `TurnActivity`
// shows the same span as a `ReasoningStep`, so a turn with an activity row
// would read "Thought for 40 seconds" twice. The row renders nothing there.
const B4ReasoningMessage = Object.assign(function B4ReasoningMessage(
  props: CopilotChatReasoningMessageProps,
) {
  const { turns } = useB4ActivityContext()
  return reasoningInActivity(turns, props.message.id) ? null : (
    <CopilotChatReasoningMessage {...props} />
  )
}, CopilotChatReasoningMessage)

export interface B4ChatSlots {
  readonly messageView: {
    readonly transformMessages: typeof mergeTurnMessages
    readonly assistantMessage: typeof B4AssistantMessage
    readonly reasoningMessage: typeof B4ReasoningMessage
  }
}

const SLOTS: B4ChatSlots = {
  messageView: {
    transformMessages: mergeTurnMessages,
    assistantMessage: B4AssistantMessage,
    reasoningMessage: B4ReasoningMessage,
  },
}

/**
 * Props to spread onto `<CopilotChat>` inside `<B4Activity>`: one tool row per
 * turn, rendered as `TurnActivity`; no toolbar under tool-only rows; no
 * separate reasoning row for a turn whose activity shows that reasoning. The slot
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
