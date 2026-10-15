import type { Navlog } from "../navlog.js"
import { type Advisory, toAdvisoryFact } from "./advisories.js"
import { coverage } from "./coverage.js"
import type { Metar } from "./metar.js"
import { categoryAt, type Taf } from "./taf.js"
import type { AirportWeather, Category, Forecast, LegWind, TimeWindow } from "./types.js"
import { verdictFloor } from "./verdict.js"

const CATEGORIES = new Set(["VFR", "MVFR", "IFR", "LIFR"])
const asCategory = (value: string | undefined): Category | null =>
  value !== undefined && CATEGORIES.has(value) ? (value as Category) : null

/**
 * Each route leg's flying interval, from the navlog rows. A leg is one or two
 * consecutive rows (a climb and a cruise) with the same from and to; rows of
 * the next leg start where the last one ended, so an out-and-back that
 * repeats a waypoint still maps cleanly.
 */
export function legIntervals(navlog: Navlog): {
  readonly leg: number
  readonly startMs: number
  readonly endMs: number
  readonly midMs: number
}[] {
  const out: { leg: number; startMs: number; endMs: number; midMs: number }[] = []
  let startMs = Date.parse(navlog.departureTimeUtc)
  let rowIndex = 0
  for (let leg = 1; leg < navlog.waypoints.length; leg++) {
    const from = navlog.waypoints[leg - 1]?.id
    const to = navlog.waypoints[leg]?.id
    let endMs = startMs
    while (rowIndex < navlog.legs.length) {
      const row = navlog.legs[rowIndex]
      if (row === undefined || row.from !== from || row.to !== to) break
      endMs = Date.parse(row.etaUtc)
      rowIndex++
    }
    out.push({ leg, startMs, endMs, midMs: (startMs + endMs) / 2 })
    startMs = endMs
  }
  return out
}

/** The instant the flight passes `alongNm` from the origin, interpolated over the rows. */
export function timeAtAlong(navlog: Navlog, alongNm: number): number {
  let flownNm = 0
  let clock = Date.parse(navlog.departureTimeUtc)
  for (const row of navlog.legs) {
    const endMs = Date.parse(row.etaUtc)
    if (alongNm <= flownNm + row.distanceNm || row === navlog.legs.at(-1)) {
      const share =
        row.distanceNm === 0 ? 1 : Math.min(1, Math.max(0, (alongNm - flownNm) / row.distanceNm))
      return Math.round(clock + share * (endMs - clock))
    }
    flownNm += row.distanceNm
    clock = endMs
  }
  return clock
}

export interface BuildForecastInput {
  readonly navlog: Navlog
  readonly winds: readonly LegWind[]
  readonly windWindows: readonly TimeWindow[]
  readonly metars: readonly Metar[]
  readonly tafs: readonly Taf[]
  readonly advisories: readonly Advisory[]
  /** En-route stations, with their distance along the route. */
  readonly stations: readonly { readonly id: string; readonly alongNm: number }[]
  /** Notes the caller already has (e.g. a leg's winds that never settled on one forecast). */
  readonly notes?: readonly string[]
}

/** Every weather fact for one planned flight, from data already fetched. Pure. */
export function buildForecast(input: BuildForecastInput): Forecast {
  const { navlog } = input
  const departureMs = Date.parse(navlog.departureTimeUtc)
  const etaMs = Date.parse(navlog.legs.at(-1)?.etaUtc ?? navlog.departureTimeUtc)
  const flight: TimeWindow = { fromMs: departureMs, toMs: etaMs }
  const metarById = new Map(input.metars.map((m) => [m.id.toUpperCase(), m]))
  const tafById = new Map(input.tafs.map((t) => [t.id.toUpperCase(), t]))
  const notes: string[] = [...(input.notes ?? [])]

  const weatherAt = (
    id: string,
    role: AirportWeather["role"],
    alongNm: number,
    atMs: number,
  ): AirportWeather => {
    const metar = metarById.get(id.toUpperCase()) ?? null
    const taf = tafById.get(id.toUpperCase()) ?? null
    if (metar !== null && taf === null) notes.push(`No TAF issued for ${id}`)
    const overlapGust = (taf?.periods ?? [])
      .filter(
        (p) =>
          p.gustKt !== undefined &&
          Date.parse(p.fromUtc) < flight.toMs &&
          Date.parse(p.toUtc) > flight.fromMs,
      )
      .map((p) => p.gustKt as number)
    const gusts = [...overlapGust, ...(metar?.gustKt != null ? [metar.gustKt] : [])]
    return {
      id,
      role,
      alongNm: Math.round(alongNm),
      atUtc: new Date(atMs).toISOString(),
      metar:
        metar === null
          ? null
          : {
              raw: metar.raw,
              category: asCategory(metar.flightCategory),
              observedAt: metar.observedAt,
            },
      taf: taf === null ? null : { raw: taf.raw, validToUtc: taf.validToUtc },
      categoryNow: metar === null ? null : asCategory(metar.flightCategory),
      categoryAtTime: taf === null ? null : categoryAt(taf, atMs, flight),
      gustKt: gusts.length === 0 ? null : Math.max(...gusts),
    }
  }

  const origin = navlog.waypoints[0]
  const destination = navlog.waypoints.at(-1)
  const airports: AirportWeather[] = []
  if (origin) airports.push(weatherAt(origin.id, "origin", 0, departureMs))
  for (const station of [...input.stations].sort((a, b) => a.alongNm - b.alongNm)) {
    airports.push(
      weatherAt(station.id, "en-route", station.alongNm, timeAtAlong(navlog, station.alongNm)),
    )
  }
  if (destination)
    airports.push(weatherAt(destination.id, "destination", navlog.totals.distanceNm, etaMs))

  const end = (a: AirportWeather | undefined) => ({
    id: a?.id ?? "",
    taf: a?.taf
      ? {
          validFromUtc: tafById.get(a.id.toUpperCase())?.validFromUtc ?? "",
          validToUtc: a.taf.validToUtc,
        }
      : null,
  })
  const cov = coverage({
    departureMs,
    etaMs,
    origin: end(airports[0]),
    destination: end(airports.at(-1)),
    legs: legIntervals(navlog),
    windWindows: input.windWindows,
  })
  const advisories = input.advisories.map((a) => toAdvisoryFact(a, departureMs, etaMs))
  return {
    winds: input.winds,
    airports,
    advisories,
    coverage: cov,
    verdictFloor: verdictFloor({
      airports,
      advisories,
      coverage: cov,
      cruiseFt: navlog.altitudeFt,
      reserveMin: navlog.totals.reserveMin,
      reserveOk: navlog.totals.reserveOk,
    }),
    notes: [...new Set(notes)],
  }
}
