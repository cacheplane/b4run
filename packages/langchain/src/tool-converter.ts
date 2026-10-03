import type { JsonSchemaProperty, StreamTransformer } from "@b4run/core"
// `/web`, not the default entry, and the difference is a hard runtime
// constraint rather than a style preference. The default entry statically
// imports `node:async_hooks` — it exists to INFER the config off
// AsyncLocalStorage when a caller omits one — and that single specifier is what
// stopped a B4.run app from linking on Cloudflare workerd without `nodejs_compat`
// (caught by the gated workerd lane; `fetch-entry-purity` externalizes
// `@langchain/*` and structurally cannot see it). Every call in this file
// passes an explicit config, which is exactly what `/web` requires, so nothing
// is inferred either way and the dispatched events are identical. The global
// AsyncLocalStorage instance the default entry installs as a side effect is
// still installed on Node: `@langchain/langgraph`'s main entry does it, and
// B4.run always loads that.
import {
  type B4ContentPart,
  type BuiltInModelProviderId,
  contentPartsText,
  type ToolDisplay,
} from "@b4run/sdk"
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"
import { type MessageContent, ToolMessage } from "@langchain/core/messages"
import { patchConfig } from "@langchain/core/runnables"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { Command } from "@langchain/langgraph"
import { z } from "zod"
import { DEFAULT_MODALITY_SUPPORT, type ModalitySupport } from "./chat-model-factory.js"
import {
  type DroppedPart,
  droppedPartsData,
  type LangChainContentBlock,
  toLangChainContent,
  V1_RESPONSE_METADATA,
} from "./content-parts.js"
import { readCallOrigin, recordToolCall } from "./tool-call-recording.js"
import { unwrapToolResult } from "./unwrap-tool-result.js"

interface B4ToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      readonly threadId?: string
      readonly params?: Readonly<Record<string, string>>
      /**
       * The provider's id for this call, stable across LangGraph's re-execution
       * of an interrupted tool node. Absent when the tool is invoked outside a
       * model tool call.
       */
      readonly toolCallId?: string
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
  /** How a call reads to a person; evaluated per call and streamed as `b4.step`. */
  readonly display?: ToolDisplay
  /** End the run on this tool's successful result; see the core `B4ToolDefinition`. */
  readonly returnDirect?: boolean
  /** The server-side stub of a client-provided tool; it records itself. Never issued as a server call. */
  readonly clientTool?: true
}

export type OffloadFn = (
  content: string,
  toolName: string,
  toolCallId?: string,
  signal?: AbortSignal,
) => Promise<string>

/** The root model's modality, for shaping a tool's media result. */
export interface ToolResultModality {
  readonly support: ModalitySupport
  readonly provider: BuiltInModelProviderId | undefined
  readonly model: string | undefined
}

/** The `additional_kwargs` key under which a ToolMessage keeps every part the tool returned, for the UI. */
export const B4_CONTENT_PARTS_KEY = "b4_content_parts"

export function convertToolToLangChain(
  tool: B4ToolDefinition,
  middlewareContext?: Readonly<Record<string, unknown>>,
  offload?: OffloadFn,
  routeParamNames: readonly string[] = [],
  streamTransformers: readonly StreamTransformer[] = [],
  modality?: ToolResultModality,
): DynamicStructuredTool {
  const schema = toZodSchema(tool.schema)
  const paramNameSet = new Set(routeParamNames)

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema,
    // A prebuilt agent that reads the flag ends the run on this tool's result
    // instead of routing back to the model. B4's own agent routes clear it and
    // end only on success (`endsOnReturnDirect`); a raw LangChain runnable
    // handed these tools keeps LangChain's behavior.
    ...(tool.returnDirect === true ? { returnDirect: true } : {}),
    func: async (input, runManager, config) => {
      const liveConfig = runManager
        ? patchConfig(config, { callbacks: runManager.getChild() })
        : config
      const signal = liveConfig?.signal ?? new AbortController().signal
      // liveConfig.configurable carries thread_id + the route params (set by the
      // agent-adapter's prepareAgentCall). Forward them so tools — and the
      // argument-constraint wrapper — can read live per-call identity.
      const configurable = (liveConfig?.configurable ?? {}) as Record<string, unknown>
      const threadId =
        typeof configurable.thread_id === "string" ? configurable.thread_id : undefined
      // Allowlist against the route's declared param names. A denylist would
      // also capture LangGraph internals injected into configurable (e.g.
      // checkpoint_ns, __pregel_task_id), which must never surface as route params.
      const params: Record<string, string> = {}
      for (const [key, value] of Object.entries(configurable)) {
        if (paramNameSet.has(key) && typeof value === "string") params[key] = value
      }
      const toolCallId = extractToolCallId(liveConfig)
      // Server-kind row in the tool-call record, around the whole body (see
      // `recordToolCall` for the park rule). The client stub records its own
      // client-kind row and is skipped via its marker. Inside a subagent the row
      // names the child's route key and the `task` call that launched it.
      const origin = readCallOrigin(liveConfig)
      const recorded =
        tool.clientTool === true
          ? undefined
          : { toolCallId, toolName: tool.name, ...(origin ? { origin } : {}) }
      const body = async () => {
        const rawResult = await tool.run(input, {
          ...(middlewareContext ? { middleware: middlewareContext } : {}),
          signal,
          ...(threadId ? { threadId } : {}),
          ...(Object.keys(params).length > 0 ? { params } : {}),
          ...(toolCallId !== "" ? { toolCallId } : {}),
        })
        const { content, stateUpdates } = unwrapToolResult(rawResult)
        let finalContent: string | readonly LangChainContentBlock[]
        let partsForUi: readonly B4ContentPart[] | undefined
        if (typeof content === "string") {
          finalContent = offload
            ? await offload(content, tool.name, toolCallId || undefined, signal)
            : content
        } else {
          partsForUi = content
          const support = modality?.support ?? DEFAULT_MODALITY_SUPPORT
          // Drops are judged on the ORIGINAL list so their indices mean what the UI sees.
          const converted = toLangChainContent(content, support, modality?.provider, "tool")
          // Offload bounds the text; media bypass it (their size is the body's business).
          const text = contentPartsText(content)
          const offloadedText =
            offload && text.length > 0
              ? await offload(text, tool.name, toolCallId || undefined, signal)
              : text
          finalContent =
            typeof converted.content === "string"
              ? offloadedText
              : placeToolText(content, converted.content, converted.dropped, offloadedText)
          if (converted.dropped.length > 0) {
            try {
              await dispatchCustomEvent(
                "b4.capability",
                {
                  event: "content_parts_dropped",
                  data: droppedPartsData(modality, converted.dropped, toolCallId),
                },
                liveConfig,
              )
            } catch {
              // The announce is secondary; the result still stands.
            }
          }
        }

        const toolMessage = (): ToolMessage =>
          new ToolMessage({
            tool_call_id: toolCallId,
            name: tool.name,
            ...(partsForUi !== undefined
              ? { additional_kwargs: { [B4_CONTENT_PARTS_KEY]: partsForUi } }
              : {}),
            // Blocks go in as `content:` with the v1 mark (see `V1_RESPONSE_METADATA`).
            ...(typeof finalContent === "string"
              ? { content: finalContent }
              : {
                  content: finalContent as unknown as MessageContent,
                  response_metadata: V1_RESPONSE_METADATA,
                }),
          })

        const convertedResult = stateUpdates
          ? new Command({ update: { ...stateUpdates, messages: [toolMessage()] } })
          : partsForUi !== undefined
            ? toolMessage()
            : finalContent

        for (const transformer of streamTransformers) {
          if (transformer.observes !== "tool_result") continue
          try {
            for await (const output of transformer.transform({
              toolName: tool.name,
              toolOutput: convertedResult,
              // The model/provider tool-call id — the public identity the root
              // AG-UI tool frames use. `extractToolCallId` returns "" when the
              // provider supplied none, in which case the field stays absent.
              ...(toolCallId ? { toolCallId } : {}),
            })) {
              await dispatchCustomEvent(
                "b4.capability",
                { event: output.event, data: output.data },
                liveConfig,
              )
            }
          } catch {
            // Capability events are secondary; preserve the successful tool result.
          }
        }

        return convertedResult
      }
      return recorded ? recordToolCall(liveConfig, recorded, body) : body()
    },
  })
}

/**
 * The model-visible blocks of a part result: the one (offloaded) text block
 * sits where the tool's FIRST text part was, the surviving media keep their
 * order around it; no text part (or empty text) means media only. `blocks` is
 * `toLangChainContent`'s output for `parts` — the survivors, in order.
 */
function placeToolText(
  parts: readonly B4ContentPart[],
  blocks: readonly LangChainContentBlock[],
  dropped: readonly DroppedPart[],
  text: string,
): LangChainContentBlock[] {
  const droppedAt = new Set(dropped.map((drop) => drop.index))
  const placed: LangChainContentBlock[] = []
  let next = 0
  let textPlaced = false
  for (const [index, part] of parts.entries()) {
    if (droppedAt.has(index)) continue
    const block = blocks[next++]
    if (part.type === "text") {
      if (!textPlaced && text.length > 0) placed.push({ type: "text", text })
      textPlaced = true
      continue
    }
    if (block !== undefined) placed.push(block)
  }
  return placed
}

function toZodSchema(value: unknown): z.ZodTypeAny {
  if (isZodObject(value)) return value
  if (isJsonSchemaObject(value)) return jsonSchemaToZod(value)
  return z.record(z.string(), z.unknown())
}

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    typeof (value as { _def?: { typeName?: unknown } })._def === "object" &&
    (value as { _def: { typeName?: unknown } })._def !== null
  )
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaProperty & { type: "object" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "object" &&
    typeof (value as { properties?: unknown }).properties === "object"
  )
}

const MAX_ZOD_DEPTH = 8

export function jsonSchemaToZod(schema: JsonSchemaProperty): z.ZodObject<z.ZodRawShape> {
  return objectToZod(schema, 0) as z.ZodObject<z.ZodRawShape>
}

function objectToZod(prop: JsonSchemaProperty, depth: number): z.ZodTypeAny {
  // Record<string,T>: schema-valued additionalProperties and no named properties.
  if (
    typeof prop.additionalProperties === "object" &&
    prop.additionalProperties !== null &&
    (!prop.properties || Object.keys(prop.properties).length === 0)
  ) {
    return z.record(z.string(), jsonSchemaFieldToZod(prop.additionalProperties, depth + 1))
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(prop.required ?? [])
  for (const [key, sub] of Object.entries(prop.properties ?? {})) {
    let field = jsonSchemaFieldToZod(sub, depth + 1)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return z.object(shape)
}

function jsonSchemaFieldToZod(prop: JsonSchemaProperty, depth = 0): z.ZodTypeAny {
  if (depth > MAX_ZOD_DEPTH) return z.string()

  // Unions are emitted as anyOf (no `type`); map to z.union.
  if (prop.anyOf && prop.anyOf.length > 0) {
    const members = prop.anyOf.map((m) => jsonSchemaFieldToZod(m, depth + 1))
    if (members.length === 1) return members[0] ?? z.unknown()
    return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  switch (prop.type) {
    case "string":
      return prop.enum && prop.enum.length > 0
        ? z.enum([...prop.enum] as [string, ...string[]])
        : z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "array": {
      const items = prop.items
      return items ? z.array(jsonSchemaFieldToZod(items, depth + 1)) : z.array(z.unknown())
    }
    case "object":
      return objectToZod(prop, depth)
    default:
      return z.unknown()
  }
}

function extractToolCallId(config: unknown): string {
  if (typeof config !== "object" || config === null) return ""
  const c = config as Record<string, unknown>
  // LangGraph 1.x exposes the tool call id in different ways depending on
  // the calling code path; try the most likely locations.
  const direct = (c.toolCall as { id?: string } | undefined)?.id
  if (typeof direct === "string") return direct
  const configurable = c.configurable as { toolCallId?: string } | undefined
  if (typeof configurable?.toolCallId === "string") return configurable.toolCallId
  const metadata = c.metadata as { tool_call_id?: string } | undefined
  if (typeof metadata?.tool_call_id === "string") return metadata.tool_call_id
  return ""
}
