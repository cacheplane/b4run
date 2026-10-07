import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { type FlightPlan, formatFplMessage } from "../lib/fpl.js"

export interface FiledFlightPlan {
  readonly status: "recorded"
  readonly path: string
  readonly transmitted: false
}

/**
 * Record an ICAO flight plan in the workspace. This writes the FPL message to
 * flight-plans/; it does not transmit to a filing service. The route approves
 * every call (tools.approve with allowAlways: false), so a person confirms each
 * filing before anything is written; no standing "Always allow" can skip it.
 */
export default async (
  input: { readonly flightPlan: FlightPlan },
  ctx: B4ToolContext,
): Promise<FiledFlightPlan> => {
  const plan = input.flightPlan
  const dof = plan.item18.replace(/^DOF\//, "")
  const departure = plan.item13.slice(0, 4)
  const destination = plan.item16.slice(0, 4)
  // These become a workspace path, so they must be exactly what the FPL items say they are.
  if (!/^\d{6}$/.test(dof)) throw new Error(`item 18 must carry DOF/YYMMDD, got "${plan.item18}"`)
  for (const [item, id] of [
    ["13", departure],
    ["16", destination],
  ] as const) {
    if (!/^[A-Z0-9]{4}$/.test(id)) {
      throw new Error(`item ${item} must start with a four-character location id, got "${id}"`)
    }
  }
  const path = `flight-plans/${dof}-${departure}-${destination}.txt`
  await ctx.fs.writeFile(path, `${formatFplMessage(plan)}\n`)
  return { status: "recorded", path, transmitted: false }
}

export const display = {
  icon: "write",
  // An infinitive: the approval card reads "The agent wants to <running>".
  running: ({ flightPlan }) =>
    `File ${flightPlan.item7} ${flightPlan.item13.slice(0, 4)} to ${flightPlan.item16.slice(0, 4)}`,
  done: (_input, out) => `Recorded the flight plan at ${out.path} (not transmitted)`,
} satisfies ToolDisplay<{ readonly flightPlan: FlightPlan }, FiledFlightPlan>
