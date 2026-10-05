import type { AirportWeather, FlightCategory, WeatherBrief } from "../lib/weather-selectors"

const ORDER: readonly FlightCategory[] = ["LIFR", "IFR", "MVFR", "VFR", "UNKNOWN"]

/** The worse of two categories; UNKNOWN only wins when both are unknown. */
export const worseCategory = (a: FlightCategory, b: FlightCategory): FlightCategory =>
  ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b

function chipText(airport: AirportWeather): string {
  if (airport.atEta !== "UNKNOWN" && airport.atEta !== airport.now) {
    return `${airport.id} ${airport.atEta} at ETA`
  }
  return `${airport.id} ${airport.now}`
}

/** Flight-category chips for each airport in the brief, plus the first winds line; raw reports open in a disclosure. */
export function WeatherStrip({ brief }: { readonly brief: WeatherBrief | null }) {
  if (brief === null || brief.airports.length === 0) return null
  return (
    <section
      className="wb-panel flex flex-wrap items-center gap-2 px-2.5 py-2"
      aria-label="Weather"
    >
      {brief.airports.map((airport) => (
        <details key={airport.id} className="relative">
          <summary
            className="wb-focus wb-cat cursor-pointer list-none"
            data-cat={worseCategory(airport.now, airport.atEta)}
          >
            {chipText(airport)}
          </summary>
          <div className="wb-panel absolute left-0 top-full z-10 mt-1 w-[22rem] max-w-[80vw] p-2.5 text-[12px]">
            <p className="font-medium">
              {airport.id}: {airport.line}
            </p>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.metar}</pre>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.taf}</pre>
          </div>
        </details>
      ))}
      {brief.winds[0] ? (
        <span className="border-l border-wb-border pl-2 text-[12px] text-wb-muted">
          {brief.winds[0]}
        </span>
      ) : null}
    </section>
  )
}
