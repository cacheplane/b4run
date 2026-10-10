import type { AgentRunResult } from "@b4run/testing"
import { describe, expect, test } from "vitest"
import quality from "../src/app/navlog/evals/navlog-quality.eval.ts"

/** A run whose only interesting field is its final message. */
const run = (finalMessage: string) =>
  ({ finalMessage, toolCalls: [], toolResults: [] }) as unknown as AgentRunResult

const scorer = (name: string) => {
  const found = quality.scorers.find((s) => s.name === name)
  if (found === undefined) throw new Error(`no scorer ${name}`)
  return found
}

const STRUCTURED_SCORERS = [
  "opens-with-bottom-line",
  "key-numbers",
  "lists-assumptions",
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
})
