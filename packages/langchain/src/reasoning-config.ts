import type { BuiltInModelProviderId, ReasoningConfig } from "@b4run/sdk"

/** What the route's resolved provider is told, and whether reasoning text will stream. */
export interface ResolvedReasoningConfig {
  /** Constructor options for the provider's chat model, possibly empty. */
  readonly constructorOptions: Readonly<Record<string, unknown>>
  /**
   * Whether reasoning text reaches the stream: OpenAI only when a `summary` is
   * requested (the Responses API streams nothing otherwise), Anthropic whenever
   * thinking is enabled. `GET /agui/:routeId` advertises exactly this.
   */
  readonly streams: boolean
}

const REASONING_KEYS = ["openai", "anthropic"] satisfies readonly (keyof ReasoningConfig)[]
const OPENAI_KEYS: readonly string[] = ["effort", "summary"]
const ANTHROPIC_KEYS: readonly string[] = ["budgetTokens"]
const MIN_BUDGET_TOKENS = 1024

/**
 * The route's reasoning controls, checked against its RESOLVED provider.
 * Throws on a value that cannot mean anything — a sub-object for another
 * provider, an unknown key such as the 0.13 flat `effort`, a budget the API
 * would reject — so a misplaced or misspelled setting fails the route when its
 * model is built instead of silently running at the provider's default (the
 * same posture as `resolveModelRetryPolicy`).
 */
export function resolveReasoningConfig(
  provider: BuiltInModelProviderId,
  reasoning: ReasoningConfig | undefined,
): ResolvedReasoningConfig {
  if (reasoning === undefined) return { constructorOptions: {}, streams: false }
  if (!isRecord(reasoning)) {
    throw new Error(
      `agent() reasoning must be an object with openai and/or anthropic, got ${describeValue(reasoning)}.`,
    )
  }
  for (const key of Object.keys(reasoning)) {
    if (!(REASONING_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `agent() reasoning has an unknown key "${key}"; valid keys are ${REASONING_KEYS.join(", ")}.`,
      )
    }
  }
  for (const key of REASONING_KEYS) {
    if (reasoning[key] === undefined || key === provider) continue
    if (provider === "openai" || provider === "anthropic") {
      throw new Error(
        `agent() reasoning.${key} is set, but the route resolves to the "${provider}" provider; set reasoning.${provider} instead.`,
      )
    }
    throw new Error(
      `agent() reasoning.${key} is set, but the route resolves to the "${provider}" provider, which has no reasoning controls in B4.run.`,
    )
  }

  if (provider === "openai" && reasoning.openai !== undefined) {
    const openai: unknown = reasoning.openai
    if (!isRecord(openai)) {
      throw new Error(`agent() reasoning.openai must be an object, got ${describeValue(openai)}.`)
    }
    for (const key of Object.keys(openai)) {
      if (!OPENAI_KEYS.includes(key)) {
        throw new Error(
          `agent() reasoning.openai has an unknown key "${key}"; valid keys are ${OPENAI_KEYS.join(", ")}.`,
        )
      }
    }
    const options: Record<string, unknown> = {
      ...(openai.effort !== undefined ? { effort: openai.effort } : {}),
      ...(openai.summary !== undefined ? { summary: openai.summary } : {}),
    }
    if (Object.keys(options).length === 0) return { constructorOptions: {}, streams: false }
    return {
      constructorOptions: {
        reasoning: options,
        // Summaries exist only on the Responses API.
        ...(openai.summary !== undefined ? { useResponsesApi: true } : {}),
      },
      streams: openai.summary !== undefined,
    }
  }

  if (provider === "anthropic" && reasoning.anthropic !== undefined) {
    const anthropic: unknown = reasoning.anthropic
    if (!isRecord(anthropic)) {
      throw new Error(
        `agent() reasoning.anthropic must be an object, got ${describeValue(anthropic)}.`,
      )
    }
    for (const key of Object.keys(anthropic)) {
      if (!ANTHROPIC_KEYS.includes(key)) {
        throw new Error(
          `agent() reasoning.anthropic has an unknown key "${key}"; valid keys are ${ANTHROPIC_KEYS.join(", ")}.`,
        )
      }
    }
    const budget = anthropic.budgetTokens
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < MIN_BUDGET_TOKENS) {
      throw new Error(
        `agent() reasoning.anthropic.budgetTokens must be a whole number of at least ${MIN_BUDGET_TOKENS}, got ${String(budget)}.`,
      )
    }
    return {
      constructorOptions: { thinking: { type: "enabled", budget_tokens: budget } },
      streams: true,
    }
  }

  return { constructorOptions: {}, streams: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `${typeof value} ${String(value)}`
}
