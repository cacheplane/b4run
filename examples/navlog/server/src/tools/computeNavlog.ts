import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { computeNavlog, type Navlog, type NavlogInput } from "../lib/navlog.js"

/**
 * Compute the navlog in code: great-circle legs, magnetic courses, the wind
 * triangle, POH climb and cruise figures, time, fuel, reserve and the ICAO
 * flight plan. Pass the waypoints from lookupAirport and lookupNavaid and the
 * winds from getWindsAloft; never estimate these numbers yourself.
 */
export default async (input: NavlogInput, _ctx: B4ToolContext): Promise<Navlog> =>
  computeNavlog(input)

export const display = {
  icon: "tool",
  running: ({ waypoints }) =>
    `Computing the navlog for ${waypoints.length - 1} leg${waypoints.length === 2 ? "" : "s"}`,
  done: (_input, log) =>
    `Computed the navlog: ${log.totals.distanceNm} nm, ${log.totals.eteMin} min, ${log.totals.fuelGal} gal, reserve ${Math.round(log.totals.reserveMin)} min`,
  sources: (log) => log.sources.map((source) => ({ title: `${source.figure} (${source.path})` })),
} satisfies ToolDisplay<NavlogInput, Navlog>
