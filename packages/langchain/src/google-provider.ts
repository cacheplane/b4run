import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import {
  AIMessage,
  AIMessageChunk,
  type AIMessageFields,
  type BaseMessage,
} from "@langchain/core/messages"
import { ChatGenerationChunk } from "@langchain/core/outputs"
import type {
  BaseChatGoogleCallOptions,
  GenerateContentApiHandler,
  GenerateContentApiHandlerParams,
  GoogleChatApiHandlerParams,
} from "@langchain/google"

type RawCandidate = { readonly ordinal: number; readonly candidate: Record<string, unknown> }

/** Reads plain objects from the provider's public custom-event payloads. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Clones replay messages with the ordered native parts that Google's converter omits. */
function replayMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    const retained = message.additional_kwargs.b4_google_raw_candidates
    if (!AIMessage.isInstance(message) || !Array.isArray(retained)) return message
    const parts = retained.flatMap((entry) => {
      const content = record(record(record(entry).candidate).content)
      return Array.isArray(content.parts) ? content.parts : []
    })
    if (!parts.length) return message
    return new AIMessage({
      ...message.toDict().data,
      content: parts as AIMessage["content"],
      response_metadata: { ...message.response_metadata, output_version: "v0" },
    } as AIMessageFields)
  })
}

/** Captures raw response candidates without replacing the upstream transport or parser. */
function captureManager(
  runManager: CallbackManagerForLLMRun | undefined,
  capture: (value: unknown) => void,
): CallbackManagerForLLMRun {
  return Object.assign(Object.create(runManager ?? null), {
    handleLLMNewToken: async () => {},
    handleCustomEvent: (name: string, data: unknown) => {
      if (name.startsWith("google-chunk-")) capture(record(data).chunk)
      if (name.startsWith("google-response-")) capture(record(data).data)
      return runManager?.handleCustomEvent(name, data)
    },
  })
}

/**
 * Supplies a public Google API handler that retains native activity and replay parts.
 * Google is an optional peer: its runtime constructor comes from the already loaded module.
 */
export function googleProviderOptions(
  moduleExports: Record<string, unknown>,
): Record<string, unknown> {
  const Handler = moduleExports.GenerateContentApiHandler as typeof GenerateContentApiHandler
  if (typeof Handler !== "function") return {}

  /** Preserves native Google evidence while delegating protocol handling upstream. */
  class RetainingGoogleHandler extends Handler {
    /** Requests explicit server activity and validated mixed client function calls. */
    override invocationParams(options?: BaseChatGoogleCallOptions) {
      const params = super.invocationParams(options)
      const builtin = params.tools?.some(
        (tool) => "googleSearch" in tool || "urlContext" in tool || "codeExecution" in tool,
      )
      if (!builtin) return params
      const functions = params.tools?.some((tool) => "functionDeclarations" in tool)
      return {
        ...params,
        toolConfig: {
          ...params.toolConfig,
          includeServerSideToolInvocations: true,
          ...(functions
            ? {
                functionCallingConfig: {
                  ...params.toolConfig?.functionCallingConfig,
                  mode: "VALIDATED" as const,
                },
              }
            : {}),
        },
      }
    }

    /** Retains non-streaming candidates in the message's serializable additional kwargs. */
    override async generate(
      messages: BaseMessage[],
      options?: BaseChatGoogleCallOptions,
      runManager?: CallbackManagerForLLMRun,
    ) {
      const retained: RawCandidate[] = []
      const manager = captureManager(runManager, (value) => {
        const candidates = record(value).candidates
        if (Array.isArray(candidates))
          for (const candidate of candidates)
            retained.push({ ordinal: retained.length, candidate: record(candidate) })
      })
      const result = await super.generate(replayMessages(messages), options, manager)
      return {
        ...result,
        generations: result.generations.map((generation) => ({
          ...generation,
          message: new AIMessage({
            ...generation.message.toDict().data,
            content: generation.message.content as AIMessage["content"],
            additional_kwargs: {
              ...generation.message.additional_kwargs,
              b4_google_raw_candidates: retained,
            },
          } as AIMessageFields),
        })),
      }
    }

    /** Yields raw evidence before converted chunks and flushes metadata-only responses. */
    override async *streamResponseChunks(
      messages: BaseMessage[],
      options?: BaseChatGoogleCallOptions,
      runManager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
      let ordinal = 0
      const pending: RawCandidate[] = []
      const manager = captureManager(runManager, (value) => {
        const candidates = record(value).candidates
        if (Array.isArray(candidates))
          for (const candidate of candidates)
            pending.push({ ordinal: ordinal++, candidate: record(candidate) })
      })
      /** Builds a supplemental chunk without adding duplicate text or client tool calls. */
      function supplemental(): ChatGenerationChunk {
        return new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            additional_kwargs: { b4_google_raw_candidates: pending.splice(0) },
          }),
        })
      }
      for await (const chunk of super.streamResponseChunks(
        replayMessages(messages),
        options,
        manager,
      )) {
        if (pending.length) {
          const raw = supplemental()
          yield raw
          await runManager?.handleLLMNewToken("", undefined, undefined, undefined, undefined, {
            chunk: raw,
          })
        }
        yield chunk
        await runManager?.handleLLMNewToken(
          chunk.text,
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk },
        )
      }
      if (pending.length) {
        const raw = supplemental()
        yield raw
        await runManager?.handleLLMNewToken("", undefined, undefined, undefined, undefined, {
          chunk: raw,
        })
      }
    }
  }

  return {
    apiHandler: (params: GoogleChatApiHandlerParams) =>
      new RetainingGoogleHandler(params as GenerateContentApiHandlerParams),
  }
}
