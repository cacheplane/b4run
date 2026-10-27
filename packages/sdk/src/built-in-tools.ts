/** Additional provider-native options, forwarded unchanged as vendors extend their APIs. */
export interface NativeBuiltInToolOptions {
  readonly [option: string]: unknown
}

/** OpenAI Responses web search options, using the provider's native field names. */
export interface OpenAIWebSearchOptions extends NativeBuiltInToolOptions {
  readonly type?: "web_search" | "web_search_preview" | "web_search_preview_2025_03_11"
  readonly search_context_size?: "low" | "medium" | "high"
  readonly filters?: { readonly allowed_domains?: readonly string[] }
  readonly user_location?: {
    readonly type: "approximate"
    readonly city?: string
    readonly country?: string
    readonly region?: string
    readonly timezone?: string
  }
}

/** OpenAI's hosted code interpreter. Defaults to an automatically created container. */
export interface OpenAICodeExecutionOptions extends NativeBuiltInToolOptions {
  readonly type?: "code_interpreter"
  readonly container?:
    | string
    | {
        readonly type: "auto"
        readonly file_ids?: readonly string[]
        readonly memory_limit?: "1g" | "4g" | "16g" | "64g"
      }
}

/** OpenAI Responses image generation options. Images are generated on the provider. */
export interface OpenAIImageGenerationOptions extends NativeBuiltInToolOptions {
  readonly type?: "image_generation"
  readonly background?: "transparent" | "opaque" | "auto"
  readonly quality?: "low" | "medium" | "high" | "auto"
  readonly size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto"
  readonly output_format?: "png" | "jpeg" | "webp"
  readonly output_compression?: number
  readonly partial_images?: number
  readonly model?: string
  readonly moderation?: "auto" | "low"
}

/** Anthropic server web search, including native version and usage/domain controls. */
export interface AnthropicWebSearchOptions extends NativeBuiltInToolOptions {
  readonly type?: "web_search_20250305" | "web_search_20260209"
  readonly name?: "web_search"
  readonly max_uses?: number
  readonly allowed_domains?: readonly string[]
  readonly blocked_domains?: readonly string[]
  readonly user_location?: {
    readonly type: "approximate"
    readonly city?: string
    readonly country?: string
    readonly region?: string
    readonly timezone?: string
  }
}

/**
 * Google Search grounding configuration in Google's native camelCase form.
 * Applications must render returned Search Suggestions HTML unchanged beside
 * the full answer, at full width, without tracking or modifying its links.
 */
export interface GoogleWebSearchOptions extends NativeBuiltInToolOptions {
  readonly excludeDomains?: readonly string[]
  readonly timeRangeFilter?: { readonly startTime?: string; readonly endTime?: string }
}

/** Google URL context configuration; URLs are supplied in the prompt. */
export interface GoogleWebFetchOptions extends NativeBuiltInToolOptions {}

/** Google hosted code execution configuration. */
export interface GoogleCodeExecutionOptions extends NativeBuiltInToolOptions {}

/** Provider-managed capabilities; `true` selects the default native configuration. */
export interface BuiltInToolsConfig {
  readonly openai?: {
    readonly webSearch?: true | OpenAIWebSearchOptions
    readonly codeExecution?: true | OpenAICodeExecutionOptions
    readonly imageGeneration?: true | OpenAIImageGenerationOptions
  }
  readonly anthropic?: {
    readonly webSearch?: true | AnthropicWebSearchOptions
  }
  readonly google?: {
    readonly webSearch?: true | GoogleWebSearchOptions
    readonly webFetch?: true | GoogleWebFetchOptions
    readonly codeExecution?: true | GoogleCodeExecutionOptions
  }
}
