/**
 * Model list prices the ledger estimates cost with, in USD per million tokens. Every figure
 * the ledger prints from these is marked `estimated` (RFC §13: "record whether values are
 * authoritative or estimated"); the provider's invoice is the authority, never this file.
 *
 * `FACTORY_PRICES_JSON` overrides or extends the table without a code change: a JSON object
 * of the same shape, `{ "<model>": { "input": n, "cachedInput": n, "output": n } }`, with an
 * optional `"asOf": "<date>"`.
 */
export interface ModelPrice {
  /** Uncached input tokens. */
  readonly input: number
  /** Input tokens served from the provider's prompt cache. */
  readonly cachedInput: number
  /** Output tokens, reasoning tokens included (the provider bills them as output). */
  readonly output: number
}

export interface PriceTable {
  readonly asOf: string
  readonly models: Readonly<Record<string, ModelPrice>>
}

/** OpenAI's published list prices for the models the example's apps default to. */
export const DEFAULT_PRICES: PriceTable = {
  asOf: "2026-10-21",
  models: {
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  },
}

/** The table in force: the defaults, with `FACTORY_PRICES_JSON` laid over them. */
export function priceTable(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const raw = env.FACTORY_PRICES_JSON
  if (!raw) return DEFAULT_PRICES
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`FACTORY_PRICES_JSON is not JSON: ${String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("FACTORY_PRICES_JSON must be a JSON object of models")
  const models: Record<string, ModelPrice> = { ...DEFAULT_PRICES.models }
  let asOf = DEFAULT_PRICES.asOf
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "asOf") {
      if (typeof value !== "string") throw new Error("FACTORY_PRICES_JSON.asOf must be a string")
      asOf = value
      continue
    }
    if (typeof value !== "object" || value === null)
      throw new Error(`FACTORY_PRICES_JSON.${key} must be an object`)
    const price = value as Record<string, unknown>
    for (const field of ["input", "cachedInput", "output"] as const)
      if (typeof price[field] !== "number" || !(price[field] >= 0))
        throw new Error(`FACTORY_PRICES_JSON.${key}.${field} must be a non-negative number`)
    models[key] = {
      input: price.input as number,
      cachedInput: price.cachedInput as number,
      output: price.output as number,
    }
  }
  return { asOf, models }
}

/** USD for one call's counts under `price`; reasoning tokens are already inside `output`. */
export function costOf(
  price: ModelPrice,
  counts: {
    readonly inputTokens: number
    readonly cachedInputTokens: number
    readonly outputTokens: number
  },
): number {
  const uncached = Math.max(0, counts.inputTokens - counts.cachedInputTokens)
  return (
    (uncached * price.input +
      counts.cachedInputTokens * price.cachedInput +
      counts.outputTokens * price.output) /
    1_000_000
  )
}
