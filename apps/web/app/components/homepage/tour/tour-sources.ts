import "server-only"
import { highlightCode } from "../highlight"
import type { DisplayCode } from "../types"
import sources from "./tour-sources.json"
import { TOUR_ROOT, type TourStopId, tourStops } from "./tour-stops"

/** Each stop's file text; tour-stops.test.ts pins it to the file at `origin`. */
export const tourSources: Readonly<Record<TourStopId, string>> = sources

/** Every stop's file, highlighted for a CodePanel. */
export async function prepareTourCode(): Promise<Readonly<Record<TourStopId, DisplayCode>>> {
  const entries = await Promise.all(
    tourStops.map(async (stop) => {
      const code = await highlightCode(
        sources[stop.id].trimEnd(),
        stop.language,
        `${TOUR_ROOT}${stop.file}`,
        "",
      )
      return [stop.id, { ...code, wrap: true }] as const
    }),
  )
  return Object.fromEntries(entries) as Record<TourStopId, DisplayCode>
}
