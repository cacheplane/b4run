import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchAdvisoriesNear } from "../lib/forecast/advisories.js"
import { buildForecast, legIntervals } from "../lib/forecast/build.js"
import { hhmmZ, intervalCovered } from "../lib/forecast/coverage.js"
import { fetchMetars } from "../lib/forecast/metar.js"
import { fetchTafs } from "../lib/forecast/taf.js"
import type { Forecast, LegWind } from "../lib/forecast/types.js"
import {
  chooseProduct,
  cruiseWind,
  cruiseWindNote,
  FORECAST_HOURS,
  fetchWindsProducts,
  windWindows,
} from "../lib/forecast/winds.js"
import { parseUtcInstant } from "../lib/fpl.js"
import {
  type Navlog,
  type NavlogInput,
  type NavlogWaypoint,
  computeNavlog as navlogOf,
} from "../lib/navlog.js"
import { routeSamplePoints } from "../lib/route-corridor.js"
import { forUseWindow } from "../lib/winds-aloft.js"

export type ComputeNavlogInput = Omit<NavlogInput, "winds"> & {
  /** The en-route stations findRouteStations returned, with their alongNm. */
  readonly stations?: readonly { readonly id: string; readonly alongNm: number }[]
}

export type ComputeNavlogOutput = Navlog & { readonly forecast: Forecast }

/** How far apart the points along the route that advisories are matched against are. */
const ADVISORY_SAMPLE_NM = 25

const midpoint = (a: NavlogWaypoint, b: NavlogWaypoint) => ({
  lat: (a.lat + b.lat) / 2,
  lon: (a.lon + b.lon) / 2,
})

/**
 * Compute the navlog and its weather in code. Pass the waypoints from
 * lookupAirport and lookupNavaid, the cruise altitude, the departure and the
 * en-route stations from findRouteStations; never pass winds. The tool times
 * every leg, takes the winds aloft forecast for the time each leg is flown,
 * and returns the legs with a forecast block: categories, advisories, whether
 * the forecasts reach the flight (coverage) and the verdict floor. The
 * forecast block is authoritative; narrate it, never recompute it.
 */
export default async (
  input: ComputeNavlogInput,
  ctx: B4ToolContext,
): Promise<ComputeNavlogOutput> => {
  const now = Date.now()
  const clock = () => now
  // Resolve a clock-time departure once, so every pass times the same flight.
  const departureTimeUtc = parseUtcInstant(input.departureTimeUtc, clock).toISOString()
  const { stations: _stations, ...navlogInput } = input
  const calm = input.waypoints.slice(1).map(() => ({ dirDegTrue: 0, speedKt: 0 }))
  const base: NavlogInput = { ...navlogInput, departureTimeUtc, winds: calm }
  const products = await fetchWindsProducts("all", ctx.signal)
  const windows = windWindows(products, now)

  // Each leg flown on another level's wind (a cruise below 3,000 ft), from
  // the last pick; the returned winds are always the last pick.
  const levelNotes = new Map<number, string>()
  const windsFor = (navlog: Navlog): LegWind[] =>
    legIntervals(navlog).map(({ leg, startMs, endMs, midMs }) => {
      const from = input.waypoints[leg - 1] as NavlogWaypoint
      const to = input.waypoints[leg] as NavlogWaypoint
      const choice = chooseProduct(products, midMs, now)
      const product = choice ? products.get(choice.forecastHours) : undefined
      const at = product ? cruiseWind(product, midpoint(from, to), input.altitudeFt) : null
      if (!choice || !at) {
        throw new Error(
          `no winds-aloft station in the published products for leg ${leg} (${from.id}–${to.id})`,
        )
      }
      const { wind } = at
      const levelNote = cruiseWindNote(leg, input.altitudeFt, at)
      if (levelNote === null) levelNotes.delete(leg)
      else levelNotes.set(leg, levelNote)
      return {
        leg,
        station: at.station,
        // The level the wind is for: the cruise, or the nearest forecast level.
        altitudeFt: at.levelFt,
        dirDegTrue: wind.dirDegTrue,
        speedKt: wind.speedKt,
        // Interpolated between levels; a whole degree is the forecast's precision.
        tempC: wind.tempC === null ? null : Math.round(wind.tempC),
        forUseFromUtc: choice.window.fromUtc,
        forUseToUtc: choice.window.toUtc,
        covered: intervalCovered(startMs, endMs, windows),
      }
    })

  // Pass 1: calm air, for each leg's time. Pass 2: the forecast for those times.
  const first = windsFor(navlogOf(base, clock))
  let navlog = navlogOf({ ...base, winds: first }, clock)
  // The winds changed the times. Re-pick each leg's product at its new mid-time;
  // when a leg moved to another product, time the flight once more on those winds.
  let winds = windsFor(navlog)
  if (winds.some((w, i) => w.forUseFromUtc !== first[i]?.forUseFromUtc)) {
    navlog = navlogOf({ ...base, winds }, clock)
  }
  // Coverage is of the intervals the returned navlog flies.
  const flown = legIntervals(navlog)
  winds = winds.map((w, i) => {
    const interval = flown[i]
    return interval
      ? { ...w, covered: intervalCovered(interval.startMs, interval.endMs, windows) }
      : w
  })
  // One re-pick only. If a leg's final mid-time still falls under another
  // forecast than the one its winds came from, keep these winds and say so.
  const unsettled = winds.flatMap((w, i) => {
    const interval = flown[i]
    const final = interval ? chooseProduct(products, interval.midMs, now) : null
    if (!interval || !final || final.window.fromUtc === w.forUseFromUtc) return []
    const used = FORECAST_HOURS.find((h) => {
      const product = products.get(h)
      return product !== undefined && forUseWindow(product, now)?.fromUtc === w.forUseFromUtc
    })
    const span = (from: string, to: string) => `${hhmmZ(Date.parse(from))}–${hhmmZ(Date.parse(to))}`
    const where = final.covered
      ? `falls in the ${final.forecastHours}-hour forecast (for use ${span(final.window.fromUtc, final.window.toUtc)})`
      : "falls outside every published forecast's window"
    return [
      `Winds for leg ${w.leg} are from ${used === undefined ? "the forecast" : `the ${used}-hour forecast`} (for use ${span(w.forUseFromUtc, w.forUseToUtc)}), but flown on those winds the leg's mid-time, ${hhmmZ(interval.midMs)}, ${where}; one re-timing did not settle it.`,
    ]
  })

  const notes = [...winds.flatMap((w) => levelNotes.get(w.leg) ?? []), ...unsettled]

  // En route: each intermediate airport waypoint, at the end of the leg
  // arriving there, then the corridor stations it does not repeat.
  const origin = input.waypoints[0]
  const destination = input.waypoints.at(-1)
  const endIds = new Set([origin?.id.toUpperCase(), destination?.id.toUpperCase()])
  const vias = input.waypoints.slice(1, -1).flatMap((w, i) => {
    const arriving = flown[i]
    if (w.kind !== "airport" || !arriving || endIds.has(w.id.toUpperCase())) return []
    return [{ id: w.id, alongNm: arriving.endNm, atMs: arriving.endMs }]
  })
  const seen = new Set(endIds)
  const stations = [...vias, ...(input.stations ?? [])].filter((s) => {
    const key = s.id.toUpperCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const ends = [origin, destination]
    .filter((w): w is NavlogWaypoint => w?.kind === "airport")
    .map((w) => w.id)
  const ids = [...new Set([...ends, ...stations.map((s) => s.id)])]
  const [metars, tafs, advisories] = await Promise.all([
    fetchMetars(ids, ctx.signal),
    fetchTafs(ids, ctx.signal),
    // Along each leg too, so an advisory across the middle of a long leg is found.
    fetchAdvisoriesNear(routeSamplePoints(input.waypoints, ADVISORY_SAMPLE_NM), ctx.signal),
  ])
  const forecast = buildForecast({
    navlog,
    winds,
    windWindows: windows,
    metars,
    tafs,
    advisories,
    stations,
    ...(notes.length > 0 ? { notes } : {}),
  })
  return { ...navlog, forecast }
}

export const display = {
  icon: "tool",
  running: ({ waypoints }) =>
    `Computing the navlog and forecast for ${waypoints.length - 1} leg${waypoints.length === 2 ? "" : "s"}`,
  done: (_input, log) =>
    `Computed the navlog and forecast: ${log.totals.distanceNm} nm, ${log.totals.eteMin} min, ${log.totals.fuelGal} gal, reserve ${Math.round(log.totals.reserveMin)} min, ${log.forecast.verdictFloor.level} floor`,
  sources: (log) => log.sources.map((source) => ({ title: `${source.figure} (${source.path})` })),
} satisfies ToolDisplay<ComputeNavlogInput, ComputeNavlogOutput>
