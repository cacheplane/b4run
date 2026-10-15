import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchAdvisoriesNear } from "../lib/forecast/advisories.js"
import { buildForecast, legIntervals } from "../lib/forecast/build.js"
import { intervalCovered } from "../lib/forecast/coverage.js"
import { fetchMetars } from "../lib/forecast/metar.js"
import { fetchTafs } from "../lib/forecast/taf.js"
import type { Forecast, LegWind } from "../lib/forecast/types.js"
import {
  chooseProduct,
  fetchWindsProducts,
  nearestWindsStation,
  windWindows,
} from "../lib/forecast/winds.js"
import { parseUtcInstant } from "../lib/fpl.js"
import {
  type Navlog,
  type NavlogInput,
  type NavlogWaypoint,
  computeNavlog as navlogOf,
} from "../lib/navlog.js"
import { interpolateWind, type StationWinds } from "../lib/winds-aloft.js"

export type ComputeNavlogInput = Omit<NavlogInput, "winds"> & {
  /** The en-route stations findRouteStations returned, with their alongNm. */
  readonly stations?: readonly { readonly id: string; readonly alongNm: number }[]
}

export type ComputeNavlogOutput = Navlog & { readonly forecast: Forecast }

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

  const windsFor = (navlog: Navlog): LegWind[] =>
    legIntervals(navlog).map(({ leg, startMs, endMs, midMs }) => {
      const from = input.waypoints[leg - 1] as NavlogWaypoint
      const to = input.waypoints[leg] as NavlogWaypoint
      const choice = chooseProduct(products, midMs, now)
      const product = choice ? products.get(choice.forecastHours) : undefined
      const station = product
        ? nearestWindsStation(midpoint(from, to), new Set(Object.keys(product.stations)))
        : null
      if (!choice || !product || !station) {
        throw new Error(
          `no winds-aloft station in the published products for leg ${leg} (${from.id}–${to.id})`,
        )
      }
      const wind = interpolateWind(product.stations[station.id] as StationWinds, input.altitudeFt)
      return {
        leg,
        station: station.id,
        altitudeFt: input.altitudeFt,
        dirDegTrue: wind.dirDegTrue,
        speedKt: wind.speedKt,
        tempC: wind.tempC,
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

  const stations = input.stations ?? []
  const ends = [input.waypoints[0], input.waypoints.at(-1)]
    .filter((w): w is NavlogWaypoint => w?.kind === "airport")
    .map((w) => w.id)
  const ids = [...new Set([...ends, ...stations.map((s) => s.id)])]
  const [metars, tafs, advisories] = await Promise.all([
    fetchMetars(ids, ctx.signal),
    fetchTafs(ids, ctx.signal),
    fetchAdvisoriesNear(input.waypoints, ctx.signal),
  ])
  const forecast = buildForecast({
    navlog,
    winds,
    windWindows: windows,
    metars,
    tafs,
    advisories,
    stations,
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
