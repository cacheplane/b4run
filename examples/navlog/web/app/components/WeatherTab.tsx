import { type ReactNode, useId } from "react"
import { type AirportWeather, advisoryLine, type Forecast, windsLine } from "../lib/forecast"
import { formatUtcHhmm } from "../lib/format"
import type { Navlog } from "../lib/navlog-types"
import { groupByRole, placeText, type RoleEntry, type RouteStation } from "../lib/weather-roles"
import { RawReport } from "./RawReport"
import { HorizonNote } from "./VerdictCard"

export interface WeatherTabProps {
  /** computeNavlog's forecast block for the navlog on screen, or null when it has none. */
  readonly forecast: Forecast | null
  readonly navlog: Navlog
  readonly stations: readonly RouteStation[]
}

/** The category an airport is shown in, on its pill and its map marker: at its time, else now. */
export function shownCategory(airport: AirportWeather): AirportWeather["categoryNow"] {
  return airport.categoryAtTime ?? airport.categoryNow
}

/**
 * "VFR", or both when they differ: "VFR now → MVFR at 1905Z", the time being
 * the airport's (the departure, the pass time or the ETA). Null when neither
 * is known.
 */
export function categoryText(airport: AirportWeather): string | null {
  const { categoryNow: now, categoryAtTime: at } = airport
  if (at === null || at === now) return now
  const when = formatUtcHhmm(airport.atUtc)
  const atText = when === "" ? at : `${at} at ${when}`
  return now === null ? atText : `${now} now → ${atText}`
}

/** Advisories during the flight first; the rest keep the forecast's order. */
const duringFlightFirst = (advisories: Forecast["advisories"]): Forecast["advisories"] => [
  ...advisories.filter((a) => a.relevance === "during-flight"),
  ...advisories.filter((a) => a.relevance !== "during-flight"),
]

function AirportCard({ entry, routeNm }: { readonly entry: RoleEntry; readonly routeNm: number }) {
  const { id, name, alongNm, airport } = entry
  const category = airport === null ? null : shownCategory(airport)
  return (
    <li className="rounded-wb-sm border border-wb-border bg-wb-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[13px] font-bold">{id}</span>
        {name !== undefined && name !== "" && name !== id ? (
          <span className="text-[12.5px] text-wb-muted">{name}</span>
        ) : null}
        {alongNm !== null ? (
          <span className="text-[12px] tabular-nums text-wb-muted">
            {placeText(alongNm, routeNm)}
          </span>
        ) : null}
        {airport !== null && category !== null ? (
          <span className="wb-cat ml-auto" data-cat={category}>
            <span className="wb-cat-dot" aria-hidden="true" />
            {categoryText(airport)}
          </span>
        ) : null}
      </div>
      {airport === null ? (
        <p className="mt-2 text-[12.5px] text-wb-muted">Not in the forecast</p>
      ) : (
        <>
          <RawReport label="METAR" raw={airport.metar?.raw ?? null} />
          <RawReport label="TAF" raw={airport.taf?.raw ?? null} />
        </>
      )}
    </li>
  )
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="mt-4 first:mt-3">
      <h3 id={id} className="wb-eyebrow">
        {title}
      </h3>
      <div className="mt-1.5">{children}</div>
    </section>
  )
}

/**
 * The sheet's Weather tab, from computeNavlog's forecast: a preliminary
 * notice naming each gap in the coverage, then the airports by route role
 * (origin, en route by distance along, destination), each with its category
 * and its raw METAR and TAF; then the winds aloft per leg and the advisories,
 * those during the flight first.
 */
export function WeatherTab({ forecast, navlog, stations }: WeatherTabProps) {
  const baseId = useId()
  const headingId = (name: string): string => `${baseId}-${name}`
  const roles = groupByRole(navlog, forecast, stations)
  const { routeNm } = roles

  if (forecast === null) {
    return (
      <div className="pb-2">
        <p className="mt-3 text-[13px] text-wb-muted">No weather brief yet.</p>
        <Section id={headingId("origin")} title="Origin">
          <p className="font-mono text-[13px] font-bold">{roles.origin.id}</p>
        </Section>
        <Section id={headingId("enroute")} title="En route">
          {roles.enRoute.length === 0 ? (
            <p className="text-[12.5px] text-wb-muted">
              No reporting stations within 25 nm of the course.
            </p>
          ) : (
            <p className="font-mono text-[13px] font-bold">
              {roles.enRoute.map((entry) => entry.id).join(" ")}
            </p>
          )}
        </Section>
        <Section id={headingId("destination")} title="Destination">
          <p className="font-mono text-[13px] font-bold">{roles.destination.id}</p>
        </Section>
      </div>
    )
  }

  const advisories = duringFlightFirst(forecast.advisories)
  return (
    <div className="pb-2">
      {forecast.coverage.preliminary ? (
        <HorizonNote text={forecast.coverage.reasons.join("; ")} className="mt-3" />
      ) : null}
      <Section id={headingId("origin")} title="Origin">
        <ul className="grid gap-2">
          <AirportCard entry={roles.origin} routeNm={routeNm} />
        </ul>
      </Section>
      <Section id={headingId("enroute")} title="En route">
        {roles.enRoute.length === 0 ? (
          <p className="text-[12.5px] text-wb-muted">
            No reporting stations within 25 nm of the course.
          </p>
        ) : (
          <ul className="grid gap-2">
            {roles.enRoute.map((entry) => (
              <AirportCard key={entry.id} entry={entry} routeNm={routeNm} />
            ))}
          </ul>
        )}
      </Section>
      <Section id={headingId("destination")} title="Destination">
        <ul className="grid gap-2">
          <AirportCard entry={roles.destination} routeNm={routeNm} />
        </ul>
      </Section>
      <Section id={headingId("winds")} title="Winds aloft">
        {forecast.winds.length === 0 ? (
          <p className="text-[12.5px] text-wb-muted">No winds in the forecast</p>
        ) : (
          <ul className="grid gap-1.5">
            {forecast.winds.map((wind) => (
              <li key={wind.leg} className="text-[13px] tabular-nums">
                {windsLine(wind)}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id={headingId("advisories")} title="Advisories">
        {advisories.length === 0 ? (
          <p className="text-[12.5px] text-wb-muted">No advisories near the route</p>
        ) : (
          <ul className="grid gap-1.5">
            {advisories.map((advisory, i) => (
              // Two G-AIRMET contours can read alike; the index keeps the keys apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed per forecast
              <li key={`${advisoryLine(advisory)}-${i}`} className="text-[13px] tabular-nums">
                {advisoryLine(advisory)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
