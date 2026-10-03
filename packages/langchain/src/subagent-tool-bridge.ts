import type { ToolDisplay } from "@b4run/sdk"

// `/web` — see the note on the same import in tool-converter.ts. The default
// entry drags `node:async_hooks` into the edge bundle to infer a config this
// module always passes explicitly.
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"
import type { RunnableConfig } from "@langchain/core/runnables"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { isGraphInterrupt } from "@langchain/langgraph"
import type { z } from "zod"
import { readCallOrigin, recordToolCall } from "./tool-call-recording.js"

export interface ResolvedSubagentGraph {
  readonly routeId: string
  /** The child route's key (`<routeId>#<mode>`), as the tool-call record names routes. */
  readonly routeKey: string
  /** The child's declared description, surfaced on `subagent.start` for clients. */
  readonly description?: string
  readonly graph: {
    invoke(input: unknown, config: RunnableConfig): Promise<unknown>
  }
}

export type SubagentResolver = (request: {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly config: RunnableConfig
}) => Promise<
  | { readonly ok: true; readonly child: ResolvedSubagentGraph }
  | { readonly ok: false; readonly message: string }
>

interface SubagentTaskPlaceholder {
  readonly description?: string
  readonly name: string
  readonly schema?: unknown
  readonly display?: ToolDisplay
}

interface B4SubagentStackEntry {
  readonly callId: string
  readonly name: string
  readonly routeId: string
  readonly routeKey: string
}

const MAX_SUBAGENT_DEPTH = 3

export function convertSubagentTaskToLangChain(
  tool: SubagentTaskPlaceholder,
  resolver: SubagentResolver,
): DynamicStructuredTool {
  if (tool.schema === undefined) {
    throw new Error("[b4] subagent task placeholder is missing its input schema")
  }
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema: tool.schema as z.ZodTypeAny,
    func: async (rawInput, manager, config) => {
      const liveConfig = config ?? {}
      // The provider's id when there is one; the random fallback is never
      // recorded (it is drawn afresh on every re-execution, so a row keyed on
      // it would be orphaned by each child park and, unsettled, never pruned).
      const providerCallId = readCallId(liveConfig)
      const callId = providerCallId ?? `task-${globalThis.crypto.randomUUID()}`
      const toolRunId =
        typeof manager?.runId === "string" && manager.runId !== "" ? manager.runId : undefined
      const input = rawInput as { input: string; subagent: string }
      // The enclosing context's origin — the stack as this task sees it, not
      // including the entry it is about to push for its own child.
      const origin = readCallOrigin(liveConfig)
      return recordToolCall(
        liveConfig,
        { toolCallId: providerCallId ?? "", toolName: tool.name, ...(origin ? { origin } : {}) },
        async () => {
          const parentB4 = readB4Metadata(liveConfig)
          const nextDepth = readDepth(parentB4) + 1

          if (nextDepth > MAX_SUBAGENT_DEPTH) {
            return `[B4_E5003] Cannot dispatch '${input.subagent}' at depth ${nextDepth}; the maximum subagent depth is ${MAX_SUBAGENT_DEPTH}.`
          }

          const resolved = await resolver({
            callId,
            name: input.subagent,
            input: input.input,
            config: liveConfig,
          })
          if (!resolved.ok) return resolved.message

          const parentStack = readSubagentStack(parentB4)
          const stackEntry: B4SubagentStackEntry = {
            callId,
            name: input.subagent,
            routeId: resolved.child.routeId,
            routeKey: resolved.child.routeKey,
          }
          const childConfig: RunnableConfig = {
            ...liveConfig,
            metadata: {
              ...(liveConfig.metadata ?? {}),
              b4: {
                ...parentB4,
                subagent_depth: nextDepth,
                subagent_stack: [...parentStack, stackEntry],
              },
            },
          }
          // `parent_call_id` names the call that dispatched THIS parent, so a
          // nested child's events can be attributed to their lineage (AG-UI
          // `parentSubagentRunId`); absent at depth 1, where the parent is root.
          const parentCallId = parentStack.at(-1)?.callId
          const eventBase = {
            call_id: callId,
            ...(parentCallId !== undefined ? { parent_call_id: parentCallId } : {}),
            ...(toolRunId !== undefined ? { tool_run_id: toolRunId } : {}),
            subagent: input.subagent,
            route_id: resolved.child.routeId,
            depth: nextDepth,
            ...(resolved.child.description !== undefined && resolved.child.description !== ""
              ? { description: resolved.child.description }
              : {}),
          }

          await dispatchCustomEvent("b4.subagent", { phase: "start", ...eventBase }, childConfig)

          let output: unknown
          try {
            output = await resolved.child.graph.invoke(
              { messages: [{ role: "user", content: input.input }] },
              childConfig,
            )
          } catch (error) {
            if (isGraphInterrupt(error) || liveConfig.signal?.aborted || isAbortError(error)) {
              throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            await dispatchCustomEvent(
              "b4.subagent",
              { phase: "end", ...eventBase, error: message },
              childConfig,
            )
            return `subagent_failed: ${message}`
          }

          const finalText = extractFinalAiText(output)
          await dispatchCustomEvent(
            "b4.subagent",
            { phase: "end", ...eventBase, final_message: finalText },
            childConfig,
          )
          return finalText
        },
      )
    },
  })
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { code?: unknown; name?: unknown }
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR"
}

function readCallId(config: RunnableConfig): string | undefined {
  const toolCall = (config as RunnableConfig & { toolCall?: { id?: unknown } }).toolCall
  if (typeof toolCall?.id === "string" && toolCall.id !== "") return toolCall.id

  const configurableId = config.configurable?.toolCallId
  if (typeof configurableId === "string" && configurableId !== "") return configurableId

  const metadataId = config.metadata?.tool_call_id
  return typeof metadataId === "string" && metadataId !== "" ? metadataId : undefined
}

function readB4Metadata(config: RunnableConfig): Record<string, unknown> {
  const b4 = config.metadata?.b4
  return typeof b4 === "object" && b4 !== null && !Array.isArray(b4)
    ? (b4 as Record<string, unknown>)
    : {}
}

function readDepth(b4: Record<string, unknown>): number {
  const depth = b4.subagent_depth
  return typeof depth === "number" && Number.isFinite(depth) ? depth : 0
}

function readSubagentStack(b4: Record<string, unknown>): readonly B4SubagentStackEntry[] {
  const stack = b4.subagent_stack
  if (!Array.isArray(stack)) return []
  return stack.filter(isSubagentStackEntry)
}

function isSubagentStackEntry(value: unknown): value is B4SubagentStackEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.callId === "string" &&
    typeof entry.name === "string" &&
    typeof entry.routeId === "string" &&
    typeof entry.routeKey === "string"
  )
}

function extractFinalAiText(output: unknown): string {
  const messages = (output as { messages?: unknown[] } | undefined)?.messages
  if (!Array.isArray(messages)) return ""

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | { content?: unknown; getType?: () => string; type?: string }
      | undefined
    const type = typeof message?.getType === "function" ? message.getType() : message?.type
    if (type !== "ai") continue
    if (typeof message?.content === "string") return message.content
    if (Array.isArray(message?.content)) {
      return message.content
        .map((block) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
            ? ((block as Record<string, unknown>).text as string)
            : "",
        )
        .join("")
    }
  }
  return ""
}
