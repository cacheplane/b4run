import type { PromptFragment } from "@b4run/core"
import {
  type BaseMessage,
  isAIMessage,
  isToolMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages"
import { isGraphInterrupt } from "@langchain/langgraph"
import { type AgentMiddleware, createMiddleware } from "langchain"
import { z } from "zod"
import {
  type ModelRetryPolicy,
  providerMaxRetries,
  resolveModelRetryPolicy,
  retryCapacityErrors,
} from "./model-call-retry.js"
import {
  buildSummarizationHook,
  type ResolvedSummarizationConfig,
  type RunningSummary,
} from "./summarization/index.js"
import { composeSystemPrompt } from "./system-prompt.js"

/**
 * Private state field carrying the messages the model sees this turn when
 * summarization condenses the history (`null` means the full history). It is
 * `createReactAgent`'s `llmInputMessages` channel under `createAgent`, with one
 * difference: the loop-entry hook writes it on EVERY model turn, so a view
 * condensed on an earlier turn can never be read on a later one. The leading
 * underscore keeps it out of the graph's input and output.
 */
const LLM_INPUT_MESSAGES = "_b4LlmInputMessages"

export interface B4AgentMiddlewareOptions {
  readonly systemPrompt: string
  readonly promptFragments: readonly PromptFragment[]
  /** The route's own state fields, which prompt fragments may read. */
  readonly stateFieldNames: readonly string[]
  readonly summarization?: ResolvedSummarizationConfig
  /** Tools that end the run on a successful result. */
  readonly returnDirectToolNames: ReadonlySet<string>
  /** The route's `retry`, resolved; defaults to 3 attempts and a 1s base delay. */
  readonly retry?: ModelRetryPolicy
}

/**
 * The middleware B4 installs on every `createAgent` route.
 *
 * Two middlewares, split by what they may write. `createAgent` hands a
 * middleware's hooks only the state fields that middleware declares, and a
 * middleware NODE (a `beforeModel` hook) writes every declared field back
 * when it returns an update, which re-applies a non-idempotent reducer such
 * as `append`. So the model/tool middleware, which has no node and never
 * writes state, declares the route's fields to read them; the loop-entry
 * middleware declares only replace-semantics fields.
 *
 * The loop-entry middleware exists only when the route summarizes or has a
 * `returnDirect` tool: each `beforeModel` hook is its own graph node and costs
 * a superstep per loop against `recursionLimit`, so a route without either
 * keeps the two-node loop it had under `createReactAgent`.
 */
export function createB4AgentMiddleware(options: B4AgentMiddlewareOptions): AgentMiddleware[] {
  // Keep B4ModelAndTools first and the only `wrapModelCall` here (the
  // loop-entry middleware has just a `beforeModel`). `createAgent` composes
  // `wrapModelCall` hooks with the first listed outermost, and wraps an error
  // thrown out of each one in a `MiddlewareError`. As the outermost, B4's
  // capacity retry sees the provider's 429 as LangChain stamped it; a
  // `wrapModelCall` middleware added after it would hand it that 429 inside
  // a `MiddlewareError`, which `isCapacityRateLimitError` looks through.
  const middleware: AgentMiddleware[] = [modelAndToolMiddleware(options)]
  const loopEntry = loopEntryMiddleware(options)
  if (loopEntry) middleware.push(loopEntry)
  return middleware
}

function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddleware {
  const readable: Record<string, z.ZodTypeAny> = { [LLM_INPUT_MESSAGES]: z.any().optional() }
  for (const name of options.stateFieldNames) readable[name] = z.any().optional()
  const composesPrompt = options.promptFragments.length > 0
  const retry = options.retry ?? resolveModelRetryPolicy(undefined)

  return createMiddleware({
    name: "B4ModelAndTools",
    stateSchema: z.object(readable),
    wrapModelCall: async (request, handler) => {
      const state = request.state as Record<string, unknown>
      const view = state[LLM_INPUT_MESSAGES]
      const messages = answerDanglingToolCalls(
        Array.isArray(view) ? (view as BaseMessage[]) : request.messages,
      )
      const systemMessage = composesPrompt
        ? new SystemMessage(
            await composeSystemPrompt(options.systemPrompt, options.promptFragments, {
              ...state,
              messages,
            }),
          )
        : request.systemMessage
      const next =
        !composesPrompt && messages === request.messages
          ? request
          : { ...request, messages, systemMessage }
      // Only this model call is sent again, never the tools around it, and
      // only for a capacity 429, which fails before the first token streams.
      return retryCapacityErrors(
        () => handler(next),
        retry,
        request.runtime.signal ? { signal: request.runtime.signal } : {},
      )
    },
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request)
      } catch (error) {
        // A human-in-the-loop interrupt is a pause, not a failure, and an
        // aborted run must stop rather than hand the model an error to read.
        if (isGraphInterrupt(error) || request.runtime.signal?.aborted) throw error
        return toolErrorMessage(error, request.toolCall.name, request.toolCall.id)
      }
    },
  }) as AgentMiddleware
}

/**
 * The history with an error result after every tool call that never got one,
 * or the same array when there is none.
 *
 * By the time the model is called, every tool call of a finished turn has a
 * result: the tools node runs them all first, and a call parked on an
 * approval interrupt runs on resume before the model is called again. So a
 * call still unanswered here belongs to a run that was cut off between the
 * model turn and its tools (`recursionLimit`, an abort, a crash), and the
 * checkpoint keeps it. Providers refuse that history (OpenAI: "An assistant
 * message with 'tool_calls' must be followed by tool messages"), which would
 * fail every later turn on the thread. Only the model's view is repaired; the
 * checkpoint is left as it is.
 */
export function answerDanglingToolCalls(messages: BaseMessage[]): BaseMessage[] {
  const answered = new Set(
    messages.flatMap((message) => (isToolMessage(message) ? [message.tool_call_id] : [])),
  )
  const dangling = (message: BaseMessage) =>
    isAIMessage(message)
      ? (message.tool_calls ?? []).filter(
          (call): call is typeof call & { id: string } =>
            call.id !== undefined && !answered.has(call.id),
        )
      : []
  if (!messages.some((message) => dangling(message).length > 0)) return messages

  const repaired: BaseMessage[] = []
  let pending: ToolMessage[] = []
  for (const message of messages) {
    // A call's results must follow its assistant message before anything
    // else, so the stand-ins go after any results the turn did record.
    if (!isToolMessage(message)) {
      repaired.push(...pending)
      pending = []
    }
    repaired.push(message)
    pending.push(
      ...dangling(message).map(
        (call) =>
          new ToolMessage({
            status: "error",
            content:
              "Error: this tool call did not run; the run that made it ended first. Its result is unknown.",
            name: call.name,
            tool_call_id: call.id,
          }),
      ),
    )
  }
  repaired.push(...pending)
  return repaired
}

/**
 * The error result the model reads when a tool fails, in the exact form
 * LangGraph's prebuilt `ToolNode` produced. Without this, `createAgent` treats
 * a tool error that escapes `wrapToolCall` as fatal, and the error messages it
 * builds itself carry no `status`, so nothing downstream (the returnDirect
 * check here, the adapter's root-tool-error projection) could tell a failed
 * call from a successful one.
 */
export function toolErrorMessage(
  error: unknown,
  name: string,
  id: string | undefined,
): ToolMessage {
  const message = error instanceof Error ? error.message : String(error)
  return new ToolMessage({
    status: "error",
    content: `Error: ${message}\n Please fix your mistakes.`,
    name,
    tool_call_id: id ?? "",
  })
}

function loopEntryMiddleware(options: B4AgentMiddlewareOptions): AgentMiddleware | undefined {
  const { returnDirectToolNames, summarization } = options
  if (returnDirectToolNames.size === 0 && !summarization) return undefined
  // The summarizer's model gets the route's `retry` too, as its `maxRetries`.
  const summarize = summarization
    ? buildSummarizationHook(summarization, {
        maxRetries: providerMaxRetries(options.retry ?? resolveModelRetryPolicy(undefined)),
      })
    : undefined

  return createMiddleware({
    name: "B4LoopEntry",
    stateSchema: z.object({
      [LLM_INPUT_MESSAGES]: z.any().optional(),
      ...(summarization ? { runningSummary: z.any().optional() } : {}),
    }),
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state, runtime) => {
        const messages = (state as { messages: BaseMessage[] }).messages
        if (endsOnReturnDirect(messages, returnDirectToolNames)) return { jumpTo: "end" }
        if (!summarize) return undefined
        const result = await summarize(
          {
            messages,
            ...((state as { runningSummary?: RunningSummary }).runningSummary
              ? { runningSummary: (state as { runningSummary: RunningSummary }).runningSummary }
              : {}),
          },
          runtime.signal ? { signal: runtime.signal } : undefined,
        )
        return {
          [LLM_INPUT_MESSAGES]: result.llmInputMessages ?? null,
          ...(result.runningSummary ? { runningSummary: result.runningSummary } : {}),
        }
      },
    },
  }) as AgentMiddleware
}

/**
 * Whether the tool results the model is about to read include a successful
 * result from a `returnDirect` tool. A failed call goes back to the model so
 * it can correct the call and retry; the first success ends the run. Only the
 * trailing tool results count: they are this turn's, and an earlier turn's
 * result already had its chance to end the run.
 */
export function endsOnReturnDirect(
  messages: readonly BaseMessage[],
  returnDirectToolNames: ReadonlySet<string>,
): boolean {
  if (returnDirectToolNames.size === 0) return false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || !isToolMessage(message)) break
    if (
      message.name !== undefined &&
      message.status !== "error" &&
      returnDirectToolNames.has(message.name)
    ) {
      return true
    }
  }
  return false
}
