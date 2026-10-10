import { describe, expect, test } from "vitest"
import { isStructuredAnswer, parseBriefAnswer } from "./parse"

const answer = (ui: unknown[]) => JSON.stringify({ ui })

describe("parseBriefAnswer", () => {
  test("reads the bottom line's level and reason", () => {
    expect(
      parseBriefAnswer(
        answer([
          { RouteSummary: { props: { from: "KSTP" } } },
          { BottomLine: { props: { level: "CAUTION", reason: "Gusts.", cite: [] } } },
        ]),
      ),
    ).toEqual({ bottomLine: { level: "CAUTION", reason: "Gusts." } })
  })

  test("an answer without a usable bottom line has none", () => {
    expect(parseBriefAnswer(answer([{ Prose: { props: { markdown: "Filed." } } }]))).toEqual({})
    expect(
      parseBriefAnswer(answer([{ BottomLine: { props: { level: "MAYBE", reason: "?" } } }])),
    ).toEqual({})
  })

  test("markdown, a partial answer, or JSON that is not an answer is null", () => {
    expect(parseBriefAnswer("Bottom line: GO — fine.")).toBeNull()
    expect(parseBriefAnswer('{"ui":[{"BottomLine":{"props":{"level":"GO"')).toBeNull()
    expect(parseBriefAnswer('{"ui": 3}')).toBeNull()
    expect(parseBriefAnswer("[1, 2]")).toBeNull()
  })
})

describe("isStructuredAnswer", () => {
  test("JSON objects, even partial, but not markdown", () => {
    expect(isStructuredAnswer('  {"ui":[')).toBe(true)
    expect(isStructuredAnswer("**Filed.**")).toBe(false)
    expect(isStructuredAnswer("")).toBe(false)
  })
})
