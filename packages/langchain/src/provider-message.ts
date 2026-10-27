import { normalizeProviderMessage } from "@b4run/sdk"
import { AIMessage } from "@langchain/core/messages"

/**
 * Stamps display metadata on a new canonical message before graph persistence.
 * Native content and provider metadata remain available for model replay.
 */
export function persistProviderMessage(message: AIMessage, provider?: string): AIMessage {
  const messageId = message.id ?? crypto.randomUUID()
  const projection = normalizeProviderMessage(message, {
    messageId,
    ...(provider ? { provider } : {}),
  })
  if (projection.calls.length === 0 && !projection.answer) return message
  const ids = new Set(projection.calls.map((call) => call.id))
  const fields: Record<string, unknown> = {
    ...message.toDict().data,
    response_metadata: message.response_metadata,
    usage_metadata: message.usage_metadata,
    invalid_tool_calls: message.invalid_tool_calls,
  }
  return new AIMessage({
    ...fields,
    content: message.content,
    id: messageId,
    ...(message.tool_calls
      ? { tool_calls: message.tool_calls.filter((call) => !call.id || !ids.has(call.id)) }
      : {}),
    additional_kwargs: {
      ...message.additional_kwargs,
      ...(projection.calls.length
        ? {
            b4_steps: {
              ...(typeof message.additional_kwargs.b4_steps === "object" &&
              message.additional_kwargs.b4_steps !== null
                ? message.additional_kwargs.b4_steps
                : {}),
              ...Object.fromEntries(projection.calls.map((call) => [call.id, call.step])),
            },
          }
        : {}),
      ...(projection.answer ? { b4_answer: projection.answer } : {}),
    },
  })
}
