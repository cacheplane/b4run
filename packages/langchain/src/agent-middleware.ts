import type { PromptFragment } from "@b4run/core"
import {
  type BaseMessage,
  isToolMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages"
import { isGraphInterrupt } from "@langchain/langgraph"
import { type AgentMiddleware, createMiddleware } from "langchain"
import { z } from "zod"
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
  const middleware: AgentMiddleware[] = [modelAndToolMiddleware(options)]
  const loopEntry = loopEntryMiddleware(options)
  if (loopEntry) middleware.push(loopEntry)
  return middleware
}

function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddleware {
  const readable: Record<string, z.ZodTypeAny> = { [LLM_INPUT_MESSAGES]: z.any().optional() }
  for (const name of options.stateFieldNames) readable[name] = z.any().optional()
  const composesPrompt = options.promptFragments.length > 0

  return createMiddleware({
    name: "B4ModelAndTools",
    stateSchema: z.object(readable),
    wrapModelCall: async (request, handler) => {
      const state = request.state as Record<string, unknown>
      const view = state[LLM_INPUT_MESSAGES]
      const messages = Array.isArray(view) ? (view as BaseMessage[]) : request.messages
      if (!composesPrompt && messages === request.messages) return handler(request)
      const systemMessage = composesPrompt
        ? new SystemMessage(
            await composeSystemPrompt(options.systemPrompt, options.promptFragments, {
              ...state,
              messages,
            }),
          )
        : request.systemMessage
      return handler({ ...request, messages, systemMessage })
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
  const summarize = summarization ? buildSummarizationHook(summarization) : undefined

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
