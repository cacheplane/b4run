import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchMetars, type Metar } from "../lib/forecast/metar.js"

export type { Metar }

/** Current METAR for one or more stations, parsed, with the raw observation. */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Metar[]> =>
  (await fetchMetars(input.ids, ctx.signal)).map(({ lat, lon, name, ...metar }) => metar)

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching METARs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, metars) =>
    `Fetched METARs: ${metars.map((m) => `${m.id} ${m.flightCategory}`).join(", ")}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Metar[]>
