import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Briefs the weather for a VFR route: METARs, TAFs, winds aloft at the planned altitude for each leg, and advisories.",
  // A subagent sees every authored tool by default; allow only re-adds
  // withheld capability tools. Deny the performance subagent's tools and the
  // parent's, so each child does its own job and nothing else.
  tools: {
    allow: ["getMetar", "getTaf", "getWindsAloft", "getAdvisories"],
    deny: [
      "readDoc",
      "lookupAirport",
      "computeNavlog",
      "fileFlightPlan",
      "renderChart",
      "runBash",
      "writeFile",
      "editFile",
    ],
  },
  systemPrompt: `You are a weather briefer for a VFR flight. Given airports, waypoints, a cruise altitude and a departure time:

- \`getMetar\` and \`getTaf\` for every airport. State the flight category (VFR, MVFR, IFR, LIFR) at each, from the METAR now and the TAF at the planned time.
- \`getWindsAloft\` once per leg: choose the FB region for the route (bos, mia, chi, dfw, slc, sfo, alaska, hawaii) and the station nearest the leg's midpoint; if the station is not in the product, use one the error lists. Use the 6 hour forecast unless the departure is more than 6 hours out.
- \`getAdvisories\` at the departure, the destination and each waypoint.
- Return a brief with this shape, and nothing else:
  Airports: one line each, id, category now, category at ETA, ceiling, visibility, wind, then the raw METAR and TAF.
  Winds per leg: one line each, "leg N: dir/kt tempC at altitude, station, valid".
  Advisories: one line each or "none".
  Go/no-go note: one or two sentences.
- Never invent an observation. If a tool fails, say which and continue.`,
})
