import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

// Long-term, cross-session memory for the flight planner. The agent stores
// durable facts (what the pilot states about their aircraft, preferences, route
// notes) via the generated `remember` tool and pulls them back with `recall`.
// The demo baseline lives in workspace/aircraft/c172n.md.
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  // The model reads these descriptions when it calls `remember`. memory.md lists
  // the aircraft predicates: tail_number, cruise_rpm, usable_fuel_gal and
  // reserve_minutes; a pilot's preferences use predicates of their own.
  schema: z.object({
    subject: z.string().describe("'aircraft', 'pilot', or an airport identifier such as 'KSTP'"),
    predicate: z.string().describe("Attribute, e.g. 'tail_number', 'cruise_rpm', 'prefers'"),
    value: z.string().describe("The value as stated, without its unit, e.g. 'N52817' or '2300'"),
  }),
})
