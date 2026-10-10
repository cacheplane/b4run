import { describe, expect, test } from "vitest"
import { isStructuredAnswer, parseBriefAnswer, readBottomLine } from "./parse"

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

describe("readBottomLine", () => {
  const FULL = answer([
    {
      BottomLine: {
        props: { level: "NO-GO", reason: 'Ice "below" cruise. {not json}', cite: ["c1"] },
      },
    },
    { RouteSummary: { props: { from: "KSTP", to: "KRST" } } },
  ])

  test("reads a complete answer's bottom line", () => {
    expect(readBottomLine(FULL)).toEqual({
      level: "NO-GO",
      reason: 'Ice "below" cruise. {not json}',
    })
  })

  test("reads it from a partial answer once its props object closes", () => {
    const closed = FULL.indexOf('{"RouteSummary"')
    expect(readBottomLine(FULL.slice(0, closed))).toEqual({
      level: "NO-GO",
      reason: 'Ice "below" cruise. {not json}',
    })
    // Cut right after the props' own closing brace, the node still open.
    expect(readBottomLine(FULL.slice(0, closed - 3))).toEqual({
      level: "NO-GO",
      reason: 'Ice "below" cruise. {not json}',
    })
  })

  test("nothing while its props are still streaming, or with no BottomLine first", () => {
    const props = FULL.indexOf('"cite"')
    expect(readBottomLine(FULL.slice(0, props))).toBeNull()
    expect(readBottomLine('{"ui":[{"BottomLine":{"props":{"level":"GO"')).toBeNull()
    expect(readBottomLine('{"ui":[{"Prose":{"props":{"markdown":"Bottom line: GO"}}}')).toBeNull()
    expect(
      readBottomLine('{"ui":[{"BottomLine":{"props":{"level":"MAYBE","reason":"?","cite":[]}}'),
    ).toBeNull()
    expect(readBottomLine("Bottom line: GO — fine.")).toBeNull()
  })

  test("whitespace between the tokens is fine", () => {
    expect(
      readBottomLine(
        '{ "ui" : [ { "BottomLine" : { "props" : { "level" : "GO", "reason" : "OK.", "cite" : [] } } ,',
      ),
    ).toEqual({ level: "GO", reason: "OK." })
  })
})

describe("isStructuredAnswer", () => {
  test("JSON objects, even partial, but not markdown", () => {
    expect(isStructuredAnswer('  {"ui":[')).toBe(true)
    expect(isStructuredAnswer("**Filed.**")).toBe(false)
    expect(isStructuredAnswer("")).toBe(false)
  })
})
