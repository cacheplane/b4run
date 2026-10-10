import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Looks up Cessna 172N POH performance for the actual fields: takeoff and landing distances, the cruise row to use, and climb figures, with figure citations.",
  // A subagent sees every authored tool by default; allow only re-adds
  // withheld capability tools. Deny the weather subagent's tools and the
  // parent's, so each child does its own job and nothing else.
  tools: {
    allow: ["readDoc", "lookupAirport"],
    deny: [
      "getMetar",
      "getTaf",
      "getWindsAloft",
      "getAdvisories",
      "lookupNavaid",
      "findRouteStations",
      "computeNavlog",
      "fileFlightPlan",
      "resolveDeparture",
      "renderChart",
      "runBash",
      "writeFile",
      "editFile",
    ],
  },
  systemPrompt: `You are a performance planner for a Cessna 172N. Given airports, a cruise altitude and a cruise RPM:

- \`lookupAirport\` each airport for field elevation and runways.
- \`readDoc\` the tables you need: poh/takeoff-distance.md, poh/landing-distance.md, poh/cruise-performance.md, poh/time-fuel-distance-to-climb.md, and regs/vfr-cruising-altitudes.md when the altitude looks wrong for the direction of flight.
- Report takeoff distance at the departure field elevation and the given temperature (standard if none is given), landing distance at the destination, the cruise row (RPM, %BHP, KTAS, GPH) at the cruise pressure altitude, and the climb time, fuel and distance. Interpolate between rows and say so.
- Assume standard temperature when no temperature is given; never ask the pilot for it.
- Cite every number as [poh/<file>.md, Figure N]. Never invent a number the tables do not support.`,
})
