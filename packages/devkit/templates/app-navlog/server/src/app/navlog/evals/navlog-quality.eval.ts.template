import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { custom, defineEval, gate, llmJudge, toolCalled } from "@b4run/evals"
import { z } from "zod"
import {
  BASELINE_AIRCRAFT,
  DEPARTURE_1400,
  DEPARTURE_1500Z,
  DIRECT,
  DIRECT_TABLE,
  KOWA,
  KRST,
  KSTP,
  NOT_FILED,
  OFFER,
  ONE_ON_BOARD,
  planBrief,
  planFixtures,
  VIA_OWA_TABLE,
} from "./navlog-quality.fixtures.js"

const JUDGE_CRITERIA =
  "The answer is a structured brief that opens with a GO, CAUTION or NO-GO BottomLine, gives the ETE, fuel burned and the reserve at destination in KeyNumbers, lists its assumptions, and cites at least one POH figure in Citations. The answer's level is at least the computed verdict floor and its reason matches the forecast."
// The scripted judge turn is matched by a substring of the judge's prompt, so
// derive it from the criteria rather than restating it.
const JUDGE_MATCH = JUDGE_CRITERIA.slice(0, 32)

// The workspace the cited POH files live in, resolved from this file.
const WORKSPACE = fileURLToPath(new URL("../../../../workspace/", import.meta.url))
// The response schema the web client sends on every run (a copy of the web
// kit's briefJsonSchema; the web package's kit test keeps the two equal).
const BRIEF_SCHEMA = JSON.parse(
  readFileSync(new URL("./brief-schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>
const LEVELS = ["GO", "CAUTION", "NO-GO"] as const
/** A verdict level's order, GO lowest; -1 for anything else. */
const rank = (level: string): number => LEVELS.indexOf(level as (typeof LEVELS)[number])
// What a planning answer must never contain outside its Citations: an echoed
// tool call, the todo list's statuses, a workspace path, or ETE mislabelled as
// engine time.
const NEVER_IN_ANSWER: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "an echoed recall( call", pattern: /\brecall\(/ },
  { what: "a todo status", pattern: /\[(completed|pending|in_progress)\]/ },
  { what: "a reports/ path", pattern: /reports\// },
  { what: "an aircraft/ path", pattern: /aircraft\// },
  { what: "engine-on (ETE is takeoff to landing)", pattern: /engine-on/i },
]

const DIRECT_INPUT =
  "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable."
const VIA_OWA_INPUT =
  "Plan KSTP to KRST via KOWA at 4500, departing 1500Z, in N738ZU (172N, 2400 RPM, 50 gal usable)."
const NO_FILING_INPUT =
  "Plan KSTP to KRST at 4500 departing 1400Z in N738ZU (172N, 2400 RPM, 50 gal usable). Do not file it."
const BASELINE_INPUT = "Plan KSTP to KRST at 4500 departing 1400Z. Do not file it."

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

/** One component of a structured answer: `{ "<Name>": { "props": { … } } }`. */
type BriefNode = Readonly<Record<string, { readonly props: Readonly<Record<string, unknown>> }>>

/** The structured answer's components, or undefined when it is not `{ "ui": [...] }`. */
const briefOf = (finalMessage: string): readonly BriefNode[] | undefined => {
  try {
    const ui = (JSON.parse(finalMessage) as { ui?: unknown } | null)?.ui
    return Array.isArray(ui) ? (ui as BriefNode[]) : undefined
  } catch {
    return undefined
  }
}

const NOT_STRUCTURED = {
  score: 0,
  reason: 'the final message is not a structured answer ({ "ui": [...] })',
} as const

/** The props of the first component named `name`. */
const propsOf = (
  brief: readonly BriefNode[] | undefined,
  name: string,
): Readonly<Record<string, unknown>> | undefined =>
  brief?.find((node) => node[name] !== undefined)?.[name]?.props

/** A props `items` list, as records. */
const itemsOf = (
  props: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown>[] =>
  Array.isArray(props?.items) ? (props.items as Record<string, unknown>[]) : []

/** The props of the answer's opening BottomLine, or undefined when it does not open with one. */
const bottomLineOf = (brief: readonly BriefNode[]): Readonly<Record<string, unknown>> | undefined =>
  brief[0]?.BottomLine?.props

/** The answer's Assumptions items. */
const assumptionsOf = (brief: readonly BriefNode[]): Record<string, unknown>[] =>
  itemsOf(propsOf(brief, "Assumptions"))

export default defineEval({
  name: "navlog quality",
  dataset: [
    {
      name: "stp to rst",
      input: DIRECT_INPUT,
      fixtures: planFixtures(
        {
          input: DIRECT_INPUT,
          departure: "1400Z",
          waypoints: [KSTP, KRST],
          navlogTable: DIRECT_TABLE,
          brief: planBrief({
            ...DIRECT,
            assumptions: [DEPARTURE_1400, ONE_ON_BOARD],
            closing: OFFER,
          }),
        },
        JUDGE_MATCH,
      ),
    },
    {
      name: "stp to rst via owa",
      input: VIA_OWA_INPUT,
      fixtures: planFixtures(
        {
          input: VIA_OWA_INPUT,
          departure: "1500Z",
          waypoints: [KSTP, KOWA, KRST],
          navlogTable: VIA_OWA_TABLE,
          brief: planBrief({
            via: ["KOWA"],
            departureUtc: DEPARTURE_1500Z.brief,
            reason:
              "Hold the flight until a re-brief closer to departure confirms KSTP, KOWA and KRST VFR.",
            distanceNm: "85",
            // Illustrative, as in DIRECT: computeNavlog flies these on the live winds.
            ete: "0:43",
            fuelBurnedGal: "6.6",
            fuelAtLandingGal: "43.4",
            reserve: "6:11",
            assumptions: [
              { statement: `Departure ${DEPARTURE_1500Z.brief}`, origin: "pilot" },
              ONE_ON_BOARD,
            ],
            closing: OFFER,
          }),
        },
        JUDGE_MATCH,
      ),
    },
    {
      // b4 eval runs each case once and cannot resume an approval interrupt,
      // so this case asks for the plan only and checks nothing was filed.
      name: "plan without filing",
      input: NO_FILING_INPUT,
      fixtures: planFixtures(
        {
          input: NO_FILING_INPUT,
          departure: "1400Z",
          waypoints: [KSTP, KRST],
          navlogTable: DIRECT_TABLE,
          brief: planBrief({
            ...DIRECT,
            assumptions: [DEPARTURE_1400, ONE_ON_BOARD],
            closing: NOT_FILED,
          }),
        },
        JUDGE_MATCH,
      ),
    },
    {
      // No aircraft in the request: the plan runs on the workspace baseline, N734ST.
      name: "plan on the baseline aircraft",
      input: BASELINE_INPUT,
      fixtures: planFixtures(
        {
          input: BASELINE_INPUT,
          aircraft: BASELINE_AIRCRAFT,
          departure: "1400Z",
          waypoints: [KSTP, KRST],
          navlogTable: DIRECT_TABLE,
          brief: planBrief({
            ...DIRECT,
            assumptions: [
              DEPARTURE_1400,
              ONE_ON_BOARD,
              { statement: "Tail number N734ST (demo aircraft baseline)", origin: "default" },
              { statement: "Usable fuel 50 gal (baseline)", origin: "default" },
              { statement: "Cruise 2400 RPM (baseline)", origin: "default" },
            ],
            closing: NOT_FILED,
          }),
        },
        JUDGE_MATCH,
      ),
    },
  ],
  scorers: [
    toolCalled("computeNavlog", { threshold: 1 }),
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
    custom(
      (run, testCase) => {
        if (testCase.input !== BASELINE_INPUT) return 1
        const parsed = navlogSchema.safeParse(navlogResult(run))
        return parsed.success && parsed.data.flightPlan.item7 === "N734ST" ? 1 : 0
      },
      { name: "baseline-aircraft", threshold: 1 },
    ),
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        const first = bottomLineOf(brief)
        if (first === undefined)
          return { score: 0, reason: "the first component is not a BottomLine" }
        return typeof first.reason === "string" && rank(String(first.level)) >= 0
          ? 1
          : { score: 0, reason: `the BottomLine has no GO/CAUTION/NO-GO level and reason` }
      },
      { name: "opens-with-bottom-line", threshold: 1 },
    ),
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        const labels = itemsOf(propsOf(brief, "KeyNumbers")).map((item) => String(item.label))
        const missing = [
          { name: "ETE", pattern: /\bETE\b/i },
          { name: "fuel burned", pattern: /fuel burned/i },
          { name: "reserve", pattern: /reserve/i },
        ].filter(({ pattern }) => !labels.some((text) => pattern.test(text)))
        return missing.length === 0
          ? 1
          : {
              score: 0,
              reason: `KeyNumbers has no ${missing.map(({ name }) => name).join(", ")}`,
            }
      },
      { name: "key-numbers", threshold: 1 },
    ),
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        return assumptionsOf(brief).length > 0
          ? 1
          : { score: 0, reason: "the answer lists no Assumptions" }
      },
      { name: "lists-assumptions", threshold: 1 },
    ),
    // The answer may raise computeNavlog's verdict floor, never lower it.
    custom(
      (run) => {
        const navlog = navlogResult(run) as {
          forecast?: { verdictFloor?: { level?: string } }
        } | null
        const floor = navlog?.forecast?.verdictFloor?.level
        if (floor === undefined || rank(floor) < 0)
          return { score: 0, reason: "computeNavlog returned no verdict floor" }
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        const answer = String(bottomLineOf(brief)?.level)
        if (rank(answer) < 0) return { score: 0, reason: "the BottomLine has no level" }
        return rank(answer) >= rank(floor)
          ? 1
          : { score: 0, reason: `the BottomLine says ${answer} under a ${floor} floor` }
      },
      { name: "bottom-line-respects-floor", threshold: 1 },
    ),
    // The Workbench shows the forecast's coverage; the answer never states it.
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        const found = assumptionsOf(brief)
          .map((item) => String(item.statement))
          .filter((statement) => /prelim|coverage/i.test(statement))
        return found.length === 0
          ? 1
          : { score: 0, reason: `Assumptions state the coverage: ${found.join("; ")}` }
      },
      { name: "no-coverage-assumption", threshold: 1 },
    ),
    // At least one poh/<file>.md source, and every cited POH file exists.
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        if (brief === undefined) return NOT_STRUCTURED
        const poh = itemsOf(propsOf(brief, "Citations"))
          .map((item) => String(item.source).trim())
          .filter((source) => source.startsWith("poh/"))
        if (poh.length === 0) return { score: 0, reason: "Citations names no poh/<file>.md source" }
        const absent = poh.filter((path) => !existsSync(`${WORKSPACE}${path}`))
        return absent.length === 0
          ? 1
          : { score: 0, reason: `cited POH files do not exist: ${absent.join(", ")}` }
      },
      { name: "cites-poh", threshold: 1 },
    ),
    custom(
      (run) => {
        const brief = briefOf(run.finalMessage)
        // Unparsed text cannot be checked component by component: it fails.
        if (brief === undefined) return NOT_STRUCTURED
        const text = JSON.stringify(brief.filter((node) => node.Citations === undefined))
        const found = NEVER_IN_ANSWER.filter(({ pattern }) => pattern.test(text))
        return found.length === 0
          ? 1
          : {
              score: 0,
              reason: `outside Citations the answer has ${found.map(({ what }) => what).join(", ")}`,
            }
      },
      { name: "no-echoes-or-paths", threshold: 1 },
    ),
    custom(
      (run, testCase) => {
        const filed = run.toolCalls.some((call) => call.name === "fileFlightPlan")
        const asked = /file the flight plan/i.test(String(testCase.input))
        return filed === asked ? 1 : 0
      },
      { name: "files-only-when-asked", threshold: 1 },
    ),
    // Answered by the scripted judge turn in replay and by the real model under --live.
    llmJudge({ criteria: JUDGE_CRITERIA, model: "gpt-5-mini", threshold: 0.7 }),
  ],
  responseSchema: BRIEF_SCHEMA,
  gate: gate.all(gate.passRate(1), gate.perScorer()),
})
