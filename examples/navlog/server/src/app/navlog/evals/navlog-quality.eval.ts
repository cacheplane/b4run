import { custom, defineEval, gate, llmJudge, toolCalled } from "@b4run/evals"
import { z } from "zod"

const JUDGE_CRITERIA =
  "The brief names the flight category at every airport, states fuel burned and the reserve at destination, and cites at least one POH figure."

const legSchema = z.object({
  magneticHeading: z.number(),
  groundspeedKt: z.number().positive(),
  eteMin: z.number().nonnegative(),
  fuelGal: z.number().nonnegative(),
})
const navlogSchema = z.object({
  legs: z.array(legSchema).min(1),
  totals: z.object({
    eteMin: z.number(),
    fuelGal: z.number(),
    reserveMin: z.number(),
    reserveOk: z.boolean(),
  }),
  flightPlan: z.object({ item7: z.string(), item13: z.string(), item16: z.string() }),
})

/**
 * The value computeNavlog returned, parsed from its tool message. The offload
 * threshold in b4.config.ts keeps a navlog inline, so the content is the JSON.
 */
const navlogResult = (run: {
  toolResults: ReadonlyArray<{ name: string; content: unknown }>
}): unknown => {
  // The last call is the one the brief is based on, if the model retried.
  const content = [...run.toolResults]
    .reverse()
    .find((entry) => entry.name === "computeNavlog")?.content
  if (typeof content !== "string") return undefined
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

export default defineEval({
  name: "navlog quality",
  dataset: [
    {
      name: "stp to rst",
      input:
        "Plan a VFR flight from KSTP to KRST at 4500 feet, departing at 2026-10-06T14:00:00Z. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable.",
    },
    {
      name: "stp to rst via owa",
      input:
        "Plan KSTP to KRST via KOWA at 4500, departing at 2026-10-06T15:00:00Z, in N738ZU (172N, 2400 RPM, 50 gal usable).",
    },
    {
      // b4 eval runs each case once and cannot resume an approval interrupt,
      // so this case asks for the plan only and checks nothing was filed.
      name: "plan without filing",
      input:
        "Plan KSTP to KRST at 4500 departing at 2026-10-06T14:00:00Z in N738ZU (172N, 2400 RPM, 50 gal usable). Do not file it.",
    },
  ],
  scorers: [
    toolCalled("computeNavlog", { threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "weather" }, threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "performance" }, threshold: 1 }),
    custom((run) => (navlogSchema.safeParse(navlogResult(run)).success ? 1 : 0), {
      name: "navlog-shape",
      threshold: 1,
    }),
    custom(
      (run) => {
        const parsed = navlogSchema.safeParse(navlogResult(run))
        if (!parsed.success) return 0
        const sum = parsed.data.legs.reduce((total, leg) => total + leg.fuelGal, 0)
        return Math.abs(sum - parsed.data.totals.fuelGal) < 0.11 && parsed.data.totals.reserveOk
          ? 1
          : 0
      },
      { name: "totals-add-up-and-reserve", threshold: 1 },
    ),
    custom((run) => (/\[poh\/[a-z-]+\.md/.test(run.finalMessage) ? 1 : 0), {
      name: "cites-poh",
      threshold: 1,
    }),
    custom(
      (run, testCase) => {
        const filed = run.toolCalls.some((call) => call.name === "fileFlightPlan")
        const asked = /file the flight plan/i.test(String(testCase.input))
        return filed === asked ? 1 : 0
      },
      { name: "files-only-when-asked", threshold: 1 },
    ),
    ...(process.env.OPENAI_API_KEY
      ? [llmJudge({ criteria: JUDGE_CRITERIA, model: "gpt-5-mini", threshold: 0.7 })]
      : []),
  ],
  gate: gate.all(gate.passRate(1), gate.perScorer()),
})
