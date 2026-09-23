import { readRuntimeEnv } from "@b4run/core"
import type { BuiltInModelProviderId, ReasoningConfig } from "@b4run/sdk"
import { errorDocsUrl, validateModelId } from "@b4run/sdk"

import { defaultModelImporter } from "#default-model-importer"

type Importer = (specifier: string) => Promise<Record<string, unknown>>
type ChatModelConstructor = new (options: Record<string, unknown>) => unknown

interface ProviderSpec {
  readonly packageName: string
  readonly exportName: string
  /**
   * The environment variable this provider's package reads its credential from
   * when the constructor is given none.
   *
   * Named here so {@link createChatModel} can read it through `readRuntimeEnv`
   * and pass it explicitly. Every one of these packages resolves it with
   * LangChain's `getEnvironmentVariable`, which reaches for `process.env` — and
   * on a runtime without `process` (workerd without `nodejs_compat`, which the
   * `hono` build target deliberately omits) that yields nothing, so the model
   * fails with "Missing credentials" no matter what the deployment's bindings
   * say. `ollama` has no entry because it needs no credential.
   */
  readonly apiKeyEnv?: string
}

const providerSpecs: Record<BuiltInModelProviderId, ProviderSpec> = {
  openai: {
    packageName: "@langchain/openai",
    exportName: "ChatOpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    packageName: "@langchain/anthropic",
    exportName: "ChatAnthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  // Official LangChain JS docs and current npm availability support this stable package/class.
  google: {
    packageName: "@langchain/google-genai",
    exportName: "ChatGoogleGenerativeAI",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
  mistral: {
    packageName: "@langchain/mistralai",
    exportName: "ChatMistralAI",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  groq: { packageName: "@langchain/groq", exportName: "ChatGroq", apiKeyEnv: "GROQ_API_KEY" },
  ollama: { packageName: "@langchain/ollama", exportName: "ChatOllama" },
  xai: { packageName: "@langchain/xai", exportName: "ChatXAI", apiKeyEnv: "XAI_API_KEY" },
  openrouter: {
    packageName: "@langchain/openrouter",
    exportName: "ChatOpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
}

/** Provider → the package that ships its chat model class. */
export const providerPackages: Readonly<Record<BuiltInModelProviderId, string>> =
  Object.fromEntries(
    Object.entries(providerSpecs).map(([provider, spec]) => [provider, spec.packageName]),
  ) as Readonly<Record<BuiltInModelProviderId, string>>

/**
 * The importer used when a call site passes none. Seeded, not injected,
 * because every `createChatModel` call sits behind route execution and threading
 * an option down to it would touch every layer in between — the same reason
 * `seedB4Config` exists.
 *
 * Set by a build-emitted edge entry point, whose bundle cannot contain the
 * default below: `import(specifier)` on a variable is unresolvable to a bundler,
 * so an edge deploy must hand over a map of STATIC specifiers instead. Unset on
 * every node path, which keeps the dynamic import.
 */
let seededImporter: Importer | undefined

/** Install the process-wide fallback importer. Last call wins. */
export function seedModelImporter(importer: Importer): void {
  seededImporter = importer
}

const warnedModelIds = new Set<string>()

/** Advisory once-per-process warning; never blocks model construction. */
export function warnOnUnknownModelId(opts: {
  readonly model: string
  readonly provider: string
}): void {
  const key = `${opts.provider} ${opts.model}`
  if (warnedModelIds.has(key)) return
  const verdict = validateModelId(opts)
  if (verdict.ok) return
  warnedModelIds.add(key)
  const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
  console.warn(
    `[b4:models] [B4_E4002] model "${opts.model}" is not a known ${verdict.provider} model id.` +
      (suggestions ? ` Did you mean ${suggestions}?` : "") +
      " Proceeding anyway.",
  )
}

/**
 * The install command for the package manager that launched this process.
 * npm, pnpm, yarn and bun all set `npm_config_user_agent` (read through
 * `readRuntimeEnv`, so this stays edge-safe); npm is the default
 * because that is what `npm create b4-app` scaffolds.
 */
export function installCommand(packageName: string, userAgent: string | undefined): string {
  const manager = userAgent?.split("/", 1)[0]
  if (manager === "pnpm") return `pnpm add ${packageName}`
  if (manager === "yarn") return `yarn add ${packageName}`
  if (manager === "bun") return `bun add ${packageName}`
  return `npm install ${packageName}`
}

export function missingProviderPackageMessage(
  provider: BuiltInModelProviderId,
  packageName: string,
  userAgent?: string,
): string {
  const url = errorDocsUrl("B4_E4001")
  const docs = url ? ` See ${url}` : ""
  const install = installCommand(packageName, userAgent ?? readRuntimeEnv("npm_config_user_agent"))
  return `Provider "${provider}" requires ${packageName}. Install it with: ${install} [B4_E4001]${docs}`
}

/**
 * A JSON Schema the model's final text message must conform to, applied as the
 * provider's native schema-constrained output mode. Sent by AG-UI clients that
 * render the assistant's reply — Hashbrown's `hashbrown.responseSchema` — and
 * bound on the ROOT model only: subagents, summarization and the memory
 * extractor construct their own models and never see it.
 */
export interface JsonSchemaResponseFormat {
  readonly type: "json_schema"
  /** Provider-facing schema name (OpenAI requires one; `^[a-zA-Z0-9_-]{1,64}$`). */
  readonly name: string
  readonly schema: Readonly<Record<string, unknown>>
}

/**
 * Providers whose chat model accepts a JSON-schema output format ALONGSIDE
 * bound tools, so an agent loop can keep calling tools and still have its
 * final message constrained:
 *
 * - `openai`: `response_format: { type: "json_schema", ... }` is a call
 *   option `@langchain/openai` forwards on both the Chat Completions and
 *   Responses paths, and the API accepts it together with `tools` — a turn
 *   that calls tools returns tool calls, a turn that answers returns JSON.
 * - `anthropic`: `outputConfig.format = { type: "json_schema", ... }` is the
 *   call option `withStructuredOutput({ method: "jsonSchema" })` itself binds.
 *
 * Every other provider is REJECTED when a response format is requested rather
 * than silently run unconstrained: from the client's side an ignored schema
 * and an honored one look identical until a reply fails to parse. Gemini in
 * particular refuses `responseSchema` combined with function declarations,
 * and the OpenAI-compatible gateways (`xai`, `openrouter`, `groq`) honor
 * `response_format` only for some upstream models, which is exactly the
 * silent no-op this exists to prevent.
 */
export const JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS: readonly BuiltInModelProviderId[] = [
  "openai",
  "anthropic",
]

export function supportsJsonSchemaResponseFormat(provider: BuiltInModelProviderId): boolean {
  return JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS.includes(provider)
}

export function unsupportedResponseFormatMessage(provider: BuiltInModelProviderId): string {
  return (
    `Provider "${provider}" cannot constrain the model's final message to a JSON schema alongside tool calls, ` +
    `so a client-supplied response schema is rejected rather than ignored. ` +
    `Supported providers: ${JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS.join(", ")}.`
  )
}

interface WithConfig {
  readonly withConfig: (config: Record<string, unknown>) => unknown
}

function hasWithConfig(model: unknown): model is WithConfig {
  return (
    typeof model === "object" &&
    model !== null &&
    "withConfig" in model &&
    typeof (model as { withConfig?: unknown }).withConfig === "function"
  )
}

/**
 * Bind the response format as a call option on the constructed model. A
 * `RunnableBinding` is what `createReactAgent` expects to find when it binds
 * tools — it merges the binding's config with `bindTools`' own — so the
 * format reaches every invocation of the model loop, and the tools do too.
 */
function bindResponseFormat(
  model: unknown,
  provider: BuiltInModelProviderId,
  format: JsonSchemaResponseFormat,
): unknown {
  if (!hasWithConfig(model)) {
    throw new Error(
      `Provider "${provider}" chat model does not expose withConfig(), so a response format cannot be bound.`,
    )
  }
  switch (provider) {
    case "openai":
      return model.withConfig({
        response_format: {
          type: "json_schema",
          json_schema: { name: format.name, schema: format.schema, strict: true },
        },
      })
    case "anthropic":
      return model.withConfig({
        outputConfig: { format: { type: "json_schema", schema: format.schema } },
      })
    default:
      throw new Error(unsupportedResponseFormatMessage(provider))
  }
}

export async function createChatModel(options: {
  readonly model: string
  readonly provider: BuiltInModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly importer?: Importer
  /**
   * When set, the returned model is bound so its final message must match
   * the schema; see {@link JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS} for which
   * providers can. Any other provider rejects BEFORE its package is imported.
   */
  readonly responseFormat?: JsonSchemaResponseFormat
}): Promise<unknown> {
  if (options.responseFormat && !supportsJsonSchemaResponseFormat(options.provider)) {
    throw new Error(unsupportedResponseFormatMessage(options.provider))
  }
  warnOnUnknownModelId({ model: options.model, provider: options.provider })
  const spec = providerSpecs[options.provider]
  const importer = options.importer ?? seededImporter ?? defaultModelImporter

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await importer(spec.packageName)
  } catch (error) {
    if (isMissingModuleError(error, spec.packageName)) {
      throw new Error(missingProviderPackageMessage(options.provider, spec.packageName))
    }
    throw error
  }

  const Constructor = moduleExports[spec.exportName]
  if (typeof Constructor !== "function") {
    throw new Error(
      `Provider "${options.provider}" package ${spec.packageName} does not export ${spec.exportName}.`,
    )
  }

  const constructorOptions: Record<string, unknown> = { model: options.model }
  if (options.provider === "openai" && options.reasoning?.effort) {
    constructorOptions.reasoningEffort = options.reasoning.effort
  }

  // The credential, resolved the same way the base URL below is.
  //
  // On Node this is a NO-OP by construction: `readRuntimeEnv` prefers
  // `process.env`, so the value passed here is byte-for-byte the one the
  // provider package would have read for itself, and when the variable is unset
  // nothing is passed and the package raises its own "Missing credentials"
  // exactly as before. What it changes is the runtime with no `process` at all,
  // where the package's own lookup silently finds nothing and no binding —
  // however correctly the operator set it — could ever reach the model.
  if (spec.apiKeyEnv) {
    const apiKey = readRuntimeEnv(spec.apiKeyEnv)
    if (apiKey) constructorOptions.apiKey = apiKey
  }

  if (options.provider === "openai") {
    // NOT a `typeof process` guard: this knob is load-bearing, not debug-only.
    // Guarding it would turn a crash into an edge deploy whose base URL cannot
    // be set at all — including the workerd CI lane, which points the model at
    // a local aimock through exactly this variable. `readRuntimeEnv` still
    // prefers `process.env`, so the Node path is unchanged.
    const baseURL = readRuntimeEnv("OPENAI_BASE_URL")
    if (baseURL) {
      constructorOptions.configuration = { baseURL }
    }
  }

  const model = new (Constructor as ChatModelConstructor)(constructorOptions)
  return options.responseFormat
    ? bindResponseFormat(model, options.provider, options.responseFormat)
    : model
}

function isMissingModuleError(error: unknown, expectedPackageName: string): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" : true) &&
    referencesPackageSpecifier(error.message, expectedPackageName) &&
    /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/i.test(error.message)
  )
}

function referencesPackageSpecifier(message: string, packageName: string): boolean {
  return (
    message.includes(`'${packageName}'`) ||
    message.includes(`"${packageName}"`) ||
    message.includes(`\`${packageName}\``)
  )
}
