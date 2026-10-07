import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

// Long-term, cross-session memory for the flight planner. The agent stores
// durable facts (what the pilot states about their aircraft, preferences, route
// notes) via the generated `remember` tool and pulls them back with `recall`.
// The demo baseline lives in workspace/aircraft/c172n.md.
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({
    subject: z.string().describe("What the fact is about, e.g. a source, topic, or preference"),
    predicate: z.string().describe("The relation, e.g. 'is_credible', 'prefers', 'concluded'"),
    value: z.string().describe("The value of the fact"),
  }),
})
