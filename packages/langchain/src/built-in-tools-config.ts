import type { BuiltInToolsConfig } from "@b4run/sdk"

/** Validated native tools and the provider options needed to request their activity. */
export interface ResolvedBuiltInTools {
  readonly tools: readonly Record<string, unknown>[]
  readonly constructorOptions: Readonly<Record<string, unknown>>
  readonly callOptions: Readonly<Record<string, unknown>>
}

const capabilities: Readonly<Record<string, readonly string[]>> = {
  openai: ["webSearch", "codeExecution", "imageGeneration"],
  anthropic: ["webSearch"],
  google: ["webSearch", "webFetch", "codeExecution"],
}

/** Resolve provider-managed tools, rejecting misplaced or unsupported capabilities before imports. */
export function resolveBuiltInTools(
  provider: string,
  config: BuiltInToolsConfig | undefined,
): ResolvedBuiltInTools {
  const empty = { tools: [], constructorOptions: {}, callOptions: {} }
  if (config === undefined) return empty
  if (!isRecord(config)) throw new Error("agent() builtInTools must be a provider-keyed object.")
  for (const [key, block] of Object.entries(config)) {
    if (!Object.hasOwn(capabilities, key))
      throw new Error(`agent() builtInTools has an unsupported provider "${key}".`)
    if (block === undefined) continue
    if (key !== provider)
      throw new Error(
        `agent() builtInTools.${key} is set, but the route resolves to "${provider}".`,
      )
    if (!isRecord(block)) throw new Error(`agent() builtInTools.${key} must be an object.`)
    for (const [name, value] of Object.entries(block)) {
      if (!capabilities[key]?.includes(name))
        throw new Error(`agent() builtInTools.${key} has an unsupported capability "${name}".`)
      if (value !== undefined && value !== true && !isRecord(value))
        throw new Error(
          `agent() builtInTools.${key}.${name} must be true or a native configuration object.`,
        )
      if (isRecord(value)) validateNativeDiscriminator(key, name, value)
    }
  }
  const block = (config as Readonly<Record<string, Record<string, unknown> | undefined>>)[provider]
  if (!block) return empty
  const tools: Record<string, unknown>[] = []
  const include: string[] = []
  const native = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
  if (provider === "openai") {
    if (block.webSearch !== undefined) {
      tools.push({ type: "web_search", ...native(block.webSearch) })
      include.push("web_search_call.action.sources")
    }
    if (block.codeExecution !== undefined) {
      tools.push({
        type: "code_interpreter",
        container: { type: "auto" },
        ...native(block.codeExecution),
      })
      include.push("code_interpreter_call.outputs")
    }
    if (block.imageGeneration !== undefined)
      tools.push({ type: "image_generation", ...native(block.imageGeneration) })
    return {
      tools,
      constructorOptions: tools.length ? { useResponsesApi: true } : {},
      callOptions: include.length ? { include } : {},
    }
  }
  if (provider === "anthropic" && block.webSearch !== undefined) {
    tools.push({ type: "web_search_20250305", ...native(block.webSearch), name: "web_search" })
  }
  if (provider === "google") {
    if (block.webSearch !== undefined) tools.push({ googleSearch: native(block.webSearch) })
    if (block.webFetch !== undefined) tools.push({ urlContext: native(block.webFetch) })
    if (block.codeExecution !== undefined)
      tools.push({ codeExecution: native(block.codeExecution) })
  }
  return { tools, constructorOptions: {}, callOptions: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateNativeDiscriminator(
  provider: string,
  capability: string,
  value: Record<string, unknown>,
): void {
  const allowed =
    provider === "openai"
      ? capability === "webSearch"
        ? ["web_search", "web_search_preview", "web_search_preview_2025_03_11"]
        : capability === "codeExecution"
          ? ["code_interpreter"]
          : ["image_generation"]
      : provider === "anthropic"
        ? ["web_search_20250305", "web_search_20260209"]
        : undefined
  if (allowed && value.type !== undefined && !allowed.includes(String(value.type))) {
    throw new Error(
      `agent() builtInTools.${provider}.${capability}.type must select ${allowed.join(" or ")}.`,
    )
  }
  if (provider === "anthropic" && value.name !== undefined && value.name !== "web_search") {
    throw new Error("agent() builtInTools.anthropic.webSearch.name must be web_search.")
  }
}
