import { aggregateTokenUsage, type TokenUsage, tokenUsageFromLangChainMetadata } from "@ag-ui/core"
import type { B4UsageData } from "./types.js"

export interface UsageCollector {
  /** Record one model call. Payloads with no usable count are ignored. */
  add(data: B4UsageData): void
  /**
   * The `usage` key for a terminal event: one entry per provider+model, or
   * nothing at all when no call reported a count (the key is then absent,
   * never `[]`). Spread it into `RUN_FINISHED` / `RUN_ERROR`.
   */
  terminal(): { usage?: TokenUsage[] }
}

/**
 * Run-scoped token usage, collected per model call so a run that fails or is
 * cancelled can still report what it accrued. `tokenUsageFromLangChainMetadata`
 * encodes the protocol's rule that LangChain's `input_tokens`/`output_tokens`
 * already include the cache and reasoning details, and returns `undefined`
 * rather than zeros for a call that reported nothing.
 */
export function createUsageCollector(): UsageCollector {
  const entries: TokenUsage[] = []
  return {
    add(data) {
      const entry = tokenUsageFromLangChainMetadata(data.usage_metadata, {
        ...(data.provider !== undefined ? { provider: data.provider } : {}),
        ...(data.model !== undefined ? { model: data.model } : {}),
      })
      if (entry !== undefined) entries.push(entry)
    },
    terminal() {
      if (entries.length === 0) return {}
      // The aggregator spells "not reported" as an `undefined`-valued key; JSON
      // would drop it, but an in-process consumer should not see a key for a
      // count nobody returned either.
      return {
        usage: aggregateTokenUsage(entries).map(
          (entry) =>
            Object.fromEntries(
              Object.entries(entry).filter(([, value]) => value !== undefined),
            ) as TokenUsage,
        ),
      }
    },
  }
}
