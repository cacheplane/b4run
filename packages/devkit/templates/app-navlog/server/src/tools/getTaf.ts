import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchTafs, type Taf } from "../lib/forecast/taf.js"

export type { Taf, TafPeriod } from "../lib/forecast/taf.js"

/**
 * Current TAF for one or more stations: validity, each forecast group with its
 * decoded UTC window and flight category, and the raw forecast text.
 */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Taf[]> => fetchTafs(input.ids, ctx.signal)

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching TAFs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, tafs) => `Fetched ${tafs.length} TAF${tafs.length === 1 ? "" : "s"}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Taf[]>
