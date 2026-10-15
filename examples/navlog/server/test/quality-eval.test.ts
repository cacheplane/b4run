import type { AgentRunResult } from "@b4run/testing"
import { describe, expect, test } from "vitest"
import quality from "../src/app/navlog/evals/navlog-quality.eval.ts"

/** A run whose only interesting field is its final message. */
const run = (finalMessage: string) =>
  ({ finalMessage, toolCalls: [], toolResults: [] }) as unknown as AgentRunResult

/** A run whose computeNavlog returned a verdict floor, answered with a BottomLine of `answer`. */
const floorRun = (floor: string, answer: string) =>
  ({
    finalMessage: JSON.stringify({
      ui: [{ BottomLine: { props: { level: answer, reason: "r", cite: [] } } }],
    }),
    toolCalls: [],
    toolResults: [
      {
        name: "computeNavlog",
        content: JSON.stringify({ forecast: { verdictFloor: { level: floor, reasons: [] } } }),
      },
    ],
  }) as unknown as AgentRunResult

/** A structured answer whose Assumptions are these statements. */
const assumptionsAnswer = (statements: readonly string[]) =>
  JSON.stringify({
    ui: [
      {
        Assumptions: {
          props: { items: statements.map((statement) => ({ statement, origin: "default" })) },
        },
      },
    ],
  })

const scorer = (name: string) => {
  const found = quality.scorers.find((s) => s.name === name)
  if (found === undefined) throw new Error(`no scorer ${name}`)
  return found
}

const STRUCTURED_SCORERS = [
  "opens-with-bottom-line",
  "key-numbers",
  "lists-assumptions",
  "no-coverage-assumption",
  "cites-poh",
  "no-echoes-or-paths",
]

const testCase = { input: "Plan KSTP to KRST." }

describe("navlog quality scorers", () => {
  test("a final message that is not a structured answer scores 0 everywhere, saying why", async () => {
    for (const name of STRUCTURED_SCORERS) {
      expect(await scorer(name).score(run("Bottom line: GO. Fine."), testCase), name).toEqual({
        score: 0,
        reason: 'the final message is not a structured answer ({ "ui": [...] })',
      })
    }
  })

  test("no-echoes-or-paths names what it found outside Citations", async () => {
    const answer = JSON.stringify({
      ui: [
        { Prose: { props: { markdown: "Saved to reports/KSTP-KRST.md. recall({ query })" } } },
        { Citations: { props: { items: [{ id: "c1", source: "aircraft/c172n.md" }] } } },
      ],
    })
    expect(await scorer("no-echoes-or-paths").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "outside Citations the answer has an echoed recall( call, a reports/ path",
    })
  })

  test("the other checks say what is missing", async () => {
    const answer = JSON.stringify({
      ui: [
        { Prose: { props: { markdown: "Hello." } } },
        { KeyNumbers: { props: { items: [{ label: "ETE" }] } } },
        { Citations: { props: { items: [{ id: "c1", source: "poh/missing.md" }] } } },
      ],
    })
    expect(await scorer("opens-with-bottom-line").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "the first component is not a BottomLine",
    })
    expect(await scorer("key-numbers").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "KeyNumbers has no fuel burned, reserve",
    })
    expect(await scorer("lists-assumptions").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "the answer lists no Assumptions",
    })
    expect(await scorer("cites-poh").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "cited POH files do not exist: poh/missing.md",
    })
  })

  test("bottom-line-respects-floor fails an answer below the floor, naming both levels", async () => {
    expect(
      await scorer("bottom-line-respects-floor").score(floorRun("CAUTION", "GO"), testCase),
    ).toEqual({ score: 0, reason: "the BottomLine says GO under a CAUTION floor" })
  })

  test("bottom-line-respects-floor passes an answer at or above the floor", async () => {
    const respects = scorer("bottom-line-respects-floor")
    expect(await respects.score(floorRun("CAUTION", "CAUTION"), testCase)).toBe(1)
    expect(await respects.score(floorRun("GO", "NO-GO"), testCase)).toBe(1)
  })

  test("bottom-line-respects-floor fails a run with no computeNavlog result", async () => {
    const answer = JSON.stringify({
      ui: [{ BottomLine: { props: { level: "NO-GO", reason: "r", cite: [] } } }],
    })
    expect(await scorer("bottom-line-respects-floor").score(run(answer), testCase)).toEqual({
      score: 0,
      reason: "computeNavlog returned no verdict floor",
    })
  })

  test("no-coverage-assumption fails an assumption that states the coverage", async () => {
    const coverage = scorer("no-coverage-assumption")
    expect(
      await coverage.score(run(assumptionsAnswer(["Forecast preliminary"])), testCase),
    ).toEqual({ score: 0, reason: "Assumptions state the coverage: Forecast preliminary" })
    expect(
      await coverage.score(
        run(assumptionsAnswer(["Departure 2026-10-16 1400Z", "1 person on board assumed"])),
        testCase,
      ),
    ).toBe(1)
  })
})
