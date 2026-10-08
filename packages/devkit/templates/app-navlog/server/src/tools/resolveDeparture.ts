import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { parseUtcInstant } from "../lib/fpl.js"

export interface ResolvedDeparture {
  /** The departure as an ISO 8601 UTC instant. */
  readonly departureUtc: string
  /** Hours from now to the departure, to one decimal. */
  readonly hoursAhead: number
}

/**
 * Resolve the pilot's departure time once, before anything uses it: an ISO
 * 8601 UTC instant, a UTC clock time such as 1500Z (its next occurrence), or
 * "tomorrow 1500Z" / "today 1500Z". Pass departureUtc, never the pilot's words,
 * to the weather subagent and to computeNavlog, so both plan for the same
 * instant. Never work out a date or an hours-ahead figure yourself.
 */
export default async (
  input: { readonly departure: string },
  _ctx: B4ToolContext,
): Promise<ResolvedDeparture> => {
  const departure = parseUtcInstant(input.departure)
  const hoursAhead = Math.round(((departure.getTime() - Date.now()) / 3_600_000) * 10) / 10
  return { departureUtc: departure.toISOString(), hoursAhead }
}

export const display = {
  icon: "tool",
  running: ({ departure }) => `Resolve the departure time ${departure}`,
  done: (_input, out) =>
    `Departure ${out.departureUtc.slice(0, 16).replace("T", " ")}Z, ${out.hoursAhead} h ahead`,
} satisfies ToolDisplay<{ readonly departure: string }, ResolvedDeparture>
