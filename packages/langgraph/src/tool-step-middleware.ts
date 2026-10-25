import { type B4StepSource, mergeToolStep, readToolStep } from "@b4run/sdk"
import { isToolMessage, ToolMessage } from "@langchain/core/messages"
import { Command, isCommand, isGraphBubbleUp } from "@langchain/langgraph"
import { type AgentMiddleware, createMiddleware } from "langchain"
import { emitToolStep, normalizeToolStep } from "./tool-step.js"

/** Display callbacks receive tool arguments and the actual matching result message. */
export interface ToolStepDisplay {
  /** Open icon name interpreted by the consuming UI. */
  readonly icon?: string
  /** Label immediately before execution starts. */
  readonly running?: (args: Readonly<Record<string, unknown>>) => string
  /** Label after a successful execution; message is the actual ToolMessage, including artifacts. */
  readonly done?: (args: Readonly<Record<string, unknown>>, message: ToolMessage) => string
  /** Label after a failure, with readable error text. */
  readonly failed?: (args: Readonly<Record<string, unknown>>, errorText: string) => string
  /** Sources extracted from the actual matching ToolMessage. */
  readonly sources?: (message: ToolMessage) => readonly B4StepSource[]
}

/** Options for plain LangChain tool activity middleware. */
export interface ToolStepMiddlewareOptions {
  /** Optional display behavior by tool name; omitted tools still emit bare steps. */
  readonly display?: Readonly<Record<string, ToolStepDisplay>>
}

/** Keep display failures secondary to execution. */
function safely<T>(callback: (() => T) | undefined): T | undefined {
  try {
    return callback?.()
  } catch {
    return undefined
  }
}

/** Read an ordinary thrown error without allowing blank failures. */
function readable(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  )
    return error.message
  return "Tool call did not finish"
}

/** Extract readable text from a returned error message. */
function messageError(message: ToolMessage): string {
  if (typeof message.content === "string") return readable(message.content)
  const text = message.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
  return readable(text)
}

/**
 * Emits live running/settled steps and persists settled steps on ToolMessages.
 * Place this middleware inside approval/gating wrappers so running means actual
 * execution has started. Display failures are secondary. Commands without one
 * unambiguous matching ToolMessage pass through without invented settlement.
 * Interrupts remain unsettled; aborts emit live cancellation and preserve the
 * original abort reason, without fabricating checkpoint results. This Node
 * helper uses active runnable context; no listener means no live event.
 */
export function toolStepMiddleware(options: ToolStepMiddlewareOptions = {}): AgentMiddleware {
  return createMiddleware({
    name: "B4ToolStep",
    wrapToolCall: async (request, handler) => {
      const id = request.toolCall.id
      if (!id) return handler(request)
      const display = options.display?.[request.toolCall.name]
      const args = request.toolCall.args
      const startedAt = Date.now()
      const label = safely(display?.running ? () => display.running?.(args) : undefined)
      const running = normalizeToolStep({
        v: 1,
        kind: "server",
        status: "running",
        toolCallId: id,
        startedAt,
        ...(label !== undefined ? { label } : {}),
        ...(display?.icon !== undefined ? { icon: display.icon } : {}),
      })
      const cancel = async () => {
        await emitToolStep(undefined, {
          v: 1,
          kind: "server",
          status: "cancelled",
          toolCallId: id,
          startedAt,
          settledAt: Date.now(),
        })
      }
      if (request.runtime.signal?.aborted) {
        await cancel()
        throw request.runtime.signal.reason
      }
      await emitToolStep(undefined, running)
      if (request.runtime.signal?.aborted) {
        await cancel()
        throw request.runtime.signal.reason
      }
      let result: ToolMessage | Command
      let caughtError: { readonly message: string; readonly code?: string } | undefined
      try {
        result = await handler(request)
      } catch (error) {
        if (isGraphBubbleUp(error)) throw error
        if (request.runtime.signal?.aborted) {
          await cancel()
          throw error
        }
        if (error instanceof Error && error.name === "AbortError") {
          await cancel()
          throw error
        }
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined
        caughtError = { message: readable(error), ...(code !== undefined ? { code } : {}) }
        result = new ToolMessage({
          content: caughtError.message,
          status: "error",
          tool_call_id: id,
          name: request.toolCall.name,
        })
      }
      if (request.runtime.signal?.aborted) {
        await cancel()
        throw request.runtime.signal.reason
      }
      const match = (value: unknown): value is ToolMessage =>
        typeof value === "object" &&
        value !== null &&
        isToolMessage(value) &&
        value.tool_call_id === id
      let messages: unknown[]
      if (isCommand(result)) {
        const update = result.update
        const values = Array.isArray(update)
          ? update.filter(([key]) => key === "messages").map(([, value]) => value)
          : update && typeof update === "object" && "messages" in update
            ? [update.messages]
            : []
        messages = values.flatMap((value) => (Array.isArray(value) ? value : [value]))
      } else messages = [result]
      const matches = messages.filter(match)
      if (matches.length !== 1) return result
      const message = matches[0]
      if (!message) return result
      const existing = readToolStep(message.additional_kwargs.b4_step)
      const failed = message.status === "error" || existing?.status === "failed"
      const errorText = existing?.error?.message ?? caughtError?.message ?? messageError(message)
      const errorCode = existing?.error?.code ?? caughtError?.code
      const settledLabel = safely(
        failed
          ? display?.failed
            ? () => display.failed?.(args, errorText)
            : undefined
          : display?.done
            ? () => display.done?.(args, message)
            : undefined,
      )
      const sources = safely(display?.sources ? () => display.sources?.(message) : undefined)
      const displayFields = {
        ...(settledLabel !== undefined ? { label: settledLabel } : {}),
        ...(sources !== undefined ? { sources } : {}),
      }
      const base = mergeToolStep(
        running,
        {
          v: 1,
          kind: "server",
          status: "completed",
          settledAt: Date.now(),
          ...(!failed ? displayFields : {}),
        },
        "message",
      )
      const explicit = existing ? mergeToolStep(base, existing, "message") : base
      const merged = failed
        ? mergeToolStep(
            explicit,
            {
              v: 1,
              status: "failed",
              settledAt: Date.now(),
              ...displayFields,
              error: {
                message: errorText,
                ...(errorCode !== undefined ? { code: errorCode } : {}),
              },
            },
            "message",
          )
        : explicit
      const normalized = normalizeToolStep({ ...merged, toolCallId: id })
      const { toolCallId: _identity, ...stored } = normalized
      const copy = new ToolMessage({
        ...message,
        additional_kwargs: { ...message.additional_kwargs, b4_step: stored },
      })
      await emitToolStep(undefined, { ...stored, toolCallId: id })
      if (!isCommand(result)) return copy
      const replace = (value: unknown) =>
        Array.isArray(value)
          ? value.map((entry) => (entry === message ? copy : entry))
          : value === message
            ? copy
            : value
      const update = result.update
      const next = Array.isArray(update)
        ? update.map(
            ([key, value]) =>
              [key, key === "messages" ? replace(value) : value] as [string, unknown],
          )
        : { ...update, messages: replace((update as Record<string, unknown>).messages) }
      return new Command({ ...result, update: next })
    },
  })
}
