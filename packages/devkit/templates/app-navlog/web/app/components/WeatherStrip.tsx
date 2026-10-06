import {
  type AirportWeather,
  isPreliminary,
  parseAdvisory,
  type WeatherBrief,
  windsSummary,
  worstCategory,
} from "../lib/weather-selectors"
import { HazardChip, HorizonNote, sortAdvisories, VerdictPill } from "./VerdictCard"

/**
 * One airport's chip text. It always names the category the chip is colored
 * by (`worstCategory`), and spells out both ends when they differ, whichever
 * way the weather is trending.
 */
export function chipText(airport: AirportWeather): string {
  const { id, now, atEta } = airport
  if (now === atEta || atEta === "UNKNOWN") return `${id} ${now}`
  if (now === "UNKNOWN") return `${id} ${atEta} at ETA`
  return `${id} ${now} now, ${atEta} at ETA`
}

export interface WeatherStripProps {
  readonly brief: WeatherBrief | null
  /**
   * `wrap` (desktop): chips wrap and each report opens under its chip.
   * `row` (phone): one horizontally scrolling row; a report opens as a panel
   * along the top of the screen, because the scrolling row would clip it.
   */
  readonly layout?: "wrap" | "row"
  /** The planned cruise altitude, in feet: icing or convection at or below it is shown red. */
  readonly cruiseFt?: number | undefined
}

/**
 * The weather at a glance, over the map: the verdict, a flight-category chip
 * per airport, the advisories as hazard chips (the ones during the flight
 * loudest) and the winds aloft in words. Every chip opens its raw text.
 */
export function WeatherStrip({ brief, layout = "wrap", cruiseFt }: WeatherStripProps) {
  if (brief === null || brief.airports.length === 0) return null
  const row = layout === "row"
  const popover = `wb-panel z-30 p-3 text-[12px] ${
    row
      ? "fixed inset-x-3 top-3 max-h-[40vh] overflow-auto"
      : "absolute right-0 top-full mt-1.5 w-[24rem] max-w-[80vw]"
  }`
  const advisories = sortAdvisories(brief.advisories.map(parseAdvisory), cruiseFt)
  const firstWinds = brief.winds[0]
  const preliminary = isPreliminary(brief.horizon)
  return (
    <section
      className={`wb-panel wb-strip flex flex-col gap-1.5 px-2 py-1.5 ${row ? "" : "max-w-[56rem]"}`}
      aria-label="Weather"
    >
      <div
        className={`flex items-center gap-1.5 ${
          row ? "flex-nowrap overflow-x-auto [scrollbar-width:none]" : "flex-wrap justify-end"
        }`}
      >
        {brief.verdict ? <VerdictPill verdict={brief.verdict} /> : null}
        {brief.airports.map((airport) => (
          <details key={airport.id} className={row ? "shrink-0" : "relative"}>
            <summary
              className="wb-focus wb-cat cursor-pointer list-none whitespace-nowrap"
              data-cat={worstCategory(airport)}
            >
              <span className="wb-cat-dot" aria-hidden="true" />
              {chipText(airport)}
            </summary>
            <div className={popover}>
              <p className="font-medium">
                {airport.id}: {airport.line}
              </p>
              <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-wb-muted">
                {airport.metar}
              </pre>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-wb-muted">
                {airport.taf}
              </pre>
            </div>
          </details>
        ))}
        {advisories.map((advisory) => (
          <span key={advisory.raw} className="shrink-0">
            <HazardChip advisory={advisory} cruiseFt={cruiseFt} />
          </span>
        ))}
        {firstWinds ? (
          <details className={row ? "shrink-0" : "relative"}>
            <summary className="wb-focus wb-winds cursor-pointer list-none whitespace-nowrap">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-3.5 shrink-0"
              >
                <path d="M3 8h10a3 3 0 1 0-3-3M3 16h14a3 3 0 1 1-3 3M3 12h17" />
              </svg>
              {windsSummary(firstWinds)}
              {brief.winds.length > 1 ? (
                <span className="text-wb-muted"> +{brief.winds.length - 1}</span>
              ) : null}
            </summary>
            <div className={popover}>
              <p className="font-medium">Winds aloft per leg</p>
              <ul className="mt-1.5 grid gap-1.5">
                {brief.winds.map((line) => (
                  <li key={line}>
                    <span className="tabular-nums">{windsSummary(line)}</span>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] text-wb-muted">
                      {line}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ) : null}
        {preliminary ? (
          // The full sentence also tops the navlog's verdict card; here it is a chip.
          <details className={row ? "shrink-0" : "relative"}>
            <summary className="wb-focus wb-hazard wb-prelim cursor-pointer list-none">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-3.5 shrink-0"
              >
                <path d="M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" />
              </svg>
              Preliminary
            </summary>
            <div className={popover}>
              <HorizonNote text={brief.horizon as string} />
            </div>
          </details>
        ) : null}
      </div>
    </section>
  )
}
