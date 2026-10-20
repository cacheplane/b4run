import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { type Advisory, fetchAdvisoriesNear } from "../lib/forecast/advisories.js"

export type { Advisory } from "../lib/forecast/advisories.js"

/** G-AIRMETs, AIRMETs and SIGMETs whose area touches a point (padded half a degree), for a route corridor check. */
export default async (
  input: { readonly lat: number; readonly lon: number },
  ctx: B4ToolContext,
): Promise<Advisory[]> => fetchAdvisoriesNear([input], ctx.signal)

export const display = {
  icon: "web",
  running: ({ lat, lon }) => `Checking advisories near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
  done: (_input, advisories) =>
    advisories.length === 0
      ? "No advisories touch the route"
      : `${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} touch the route`,
  failed: () => "Couldn't check advisories",
} satisfies ToolDisplay<{ readonly lat: number; readonly lon: number }, Advisory[]>
