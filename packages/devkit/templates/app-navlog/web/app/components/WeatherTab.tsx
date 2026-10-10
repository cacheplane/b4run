import { type ReactNode, useId } from "react"
import type { Navlog } from "../lib/navlog-types"
import { groupByRole, type RoleEntry, type RouteStation } from "../lib/weather-roles"
import {
  type AirportWeather,
  isPreliminary,
  parseAdvisory,
  type WeatherBrief,
  windsSummary,
  worstCategory,
} from "../lib/weather-selectors"
import { RawReport } from "./RawReport"
import { HazardChip, HorizonNote, OutsideWindowChip, partitionAdvisories } from "./VerdictCard"

export interface WeatherTabProps {
  readonly weather: WeatherBrief | null
  readonly navlog: Navlog
  readonly stations: readonly RouteStation[]
  /** The planned cruise altitude, in feet: icing or convection at or below it is shown red. */
  readonly cruiseFt?: number | undefined
}

/** "VFR", or both ends when they differ: "VFR now → MVFR at ETA". */
export function categoryText({ now, atEta }: AirportWeather): string {
  if (now === atEta || atEta === "UNKNOWN") return now
  if (now === "UNKNOWN") return `${atEta} at ETA`
  return `${now} now → ${atEta} at ETA`
}

function AirportCard({ entry }: { readonly entry: RoleEntry }) {
  const { id, name, alongNm, airport } = entry
  return (
    <li className="rounded-wb-sm border border-wb-border bg-wb-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[13px] font-bold">{id}</span>
        {name !== undefined && name !== "" && name !== id ? (
          <span className="text-[12.5px] text-wb-muted">{name}</span>
        ) : null}
        {alongNm !== null ? (
          <span className="text-[12px] tabular-nums text-wb-muted">
            {Math.round(alongNm) === 0 ? "near departure" : `${Math.round(alongNm)} nm along`}
          </span>
        ) : null}
        {airport !== null ? (
          <span className="wb-cat ml-auto" data-cat={worstCategory(airport)}>
            <span className="wb-cat-dot" aria-hidden="true" />
            {categoryText(airport)}
          </span>
        ) : null}
      </div>
      {airport === null ? (
        <p className="mt-2 text-[12.5px] text-wb-muted">No report in the brief</p>
      ) : (
        <>
          <RawReport label="METAR" text={airport.metar} />
          <RawReport label="TAF" text={airport.taf} />
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
 * The sheet's Weather tab: the brief by route role (origin, the airports and
 * reporting stations en route by distance along, destination), each with its
 * category now and at ETA and its raw METAR and TAF; then the winds aloft per
 * leg, the advisories as hazard chips and the forecast-horizon note.
 */
export function WeatherTab({ weather, navlog, stations, cruiseFt }: WeatherTabProps) {
  const baseId = useId()
  const headingId = (name: string): string => `${baseId}-${name}`
  const roles = groupByRole(weather, navlog, stations)

  if (weather === null) {
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

  const { relevant, outside } = partitionAdvisories(weather.advisories.map(parseAdvisory), cruiseFt)
  return (
    <div className="pb-2">
      <Section id={headingId("origin")} title="Origin">
        <ul className="grid gap-2">
          <AirportCard entry={roles.origin} />
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
              <AirportCard key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </Section>
      <Section id={headingId("destination")} title="Destination">
        <ul className="grid gap-2">
          <AirportCard entry={roles.destination} />
        </ul>
      </Section>
      <Section id={headingId("winds")} title="Winds aloft">
        {weather.winds.length === 0 ? (
          <p className="text-[12.5px] text-wb-muted">No winds in the brief</p>
        ) : (
          <ul className="grid gap-1.5">
            {weather.winds.map((line) => (
              <li key={line}>
                <span className="text-[13px] tabular-nums">{windsSummary(line)}</span>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-wb-muted">
                  {line}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id={headingId("advisories")} title="Advisories">
        {relevant.length + outside.length === 0 ? (
          <p className="text-[12.5px] text-wb-muted">No advisories in the brief</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {relevant.map((advisory) => (
              <li key={advisory.raw}>
                <HazardChip advisory={advisory} cruiseFt={cruiseFt} />
              </li>
            ))}
            {outside.length > 0 ? (
              <li>
                <OutsideWindowChip advisories={outside} />
              </li>
            ) : null}
          </ul>
        )}
      </Section>
      {weather.horizon !== undefined && weather.horizon !== "" ? (
        <Section id={headingId("horizon")} title="Forecast horizon">
          {isPreliminary(weather.horizon) ? (
            <HorizonNote text={weather.horizon} />
          ) : (
            <p className="text-[12.5px] text-wb-muted">{weather.horizon}</p>
          )}
        </Section>
      ) : null}
    </div>
  )
}
