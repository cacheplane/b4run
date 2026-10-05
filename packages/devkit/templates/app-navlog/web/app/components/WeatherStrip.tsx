import { type AirportWeather, type WeatherBrief, worstCategory } from "../lib/weather-selectors"

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
}

/** Flight-category chips for each airport in the brief, plus the first winds line; raw reports open in a disclosure. */
export function WeatherStrip({ brief, layout = "wrap" }: WeatherStripProps) {
  if (brief === null || brief.airports.length === 0) return null
  const row = layout === "row"
  return (
    <section
      className={`wb-panel flex items-center gap-2 px-2.5 py-2 ${
        row ? "flex-nowrap overflow-x-auto" : "flex-wrap"
      }`}
      aria-label="Weather"
    >
      {brief.airports.map((airport) => (
        <details key={airport.id} className={row ? "shrink-0" : "relative"}>
          <summary
            className="wb-focus wb-cat cursor-pointer list-none whitespace-nowrap"
            data-cat={worstCategory(airport)}
          >
            {chipText(airport)}
          </summary>
          <div
            className={`wb-panel z-30 p-2.5 text-[12px] ${
              row
                ? "fixed inset-x-3 top-3 max-h-[40vh] overflow-auto"
                : "absolute right-0 top-full mt-1 w-[22rem] max-w-[80vw]"
            }`}
          >
            <p className="font-medium">
              {airport.id}: {airport.line}
            </p>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.metar}</pre>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.taf}</pre>
          </div>
        </details>
      ))}
      {brief.winds[0] ? (
        <span
          className={`border-l border-wb-border pl-2 text-[12px] text-wb-muted ${
            row ? "shrink-0 whitespace-nowrap" : ""
          }`}
        >
          {brief.winds[0]}
        </span>
      ) : null}
    </section>
  )
}
