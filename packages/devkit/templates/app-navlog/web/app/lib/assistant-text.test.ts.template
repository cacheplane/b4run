import { describe, expect, test } from "vitest"
import { inlineSegments, stripToolEchoes, textBlocks } from "./assistant-text"

describe("stripToolEchoes", () => {
  test("drops one-line tool call echoes in their common forms", () => {
    const text = [
      'recall({ query: "aircraft profile and pilot preferences" })',
      '`getMetar({ids:"KSTP"})`',
      '- task({ subagent: "weather", input: "brief" })',
      "KSTP and KRST are VFR.",
    ].join("\n")
    expect(stripToolEchoes(text)).toBe("KSTP and KRST are VFR.")
  })
  test("drops an echo that spans lines", () => {
    expect(stripToolEchoes('computeNavlog({\n  route: ["KSTP", "KRST"],\n})\nDone.')).toBe("Done.")
  })
  test("drops the Plan and todos header and its status lines, keeping what follows", () => {
    const text = [
      "**Plan and todos:**",
      "- [completed] Recall the aircraft profile",
      "[in_progress] Brief the weather",
      "[pending] Compute the navlog",
      "",
      "Bottom line: GO — VFR all the way.",
    ].join("\n")
    expect(stripToolEchoes(text)).toBe("Bottom line: GO — VFR all the way.")
  })
  test("keeps prose that merely mentions a call or brackets", () => {
    const text =
      "I called recall({ query }) earlier, and the [completed] plan is below.\nUse f(x) with care."
    expect(stripToolEchoes(text)).toBe(text)
  })
  test("collapses the blank lines left behind", () => {
    expect(stripToolEchoes("A\n\nrecall({ q: 1 })\n\n\nB")).toBe("A\n\nB")
  })
})

describe("textBlocks and inlineSegments", () => {
  test("headings, lists and paragraphs", () => {
    expect(
      textBlocks("## Weather\nVFR now.\nStill VFR.\n- one\n- two\n\n1. first\n**Fuel:**\nPlenty."),
    ).toEqual([
      { kind: "heading", text: "Weather" },
      { kind: "paragraph", text: "VFR now. Still VFR." },
      { kind: "list", ordered: false, items: ["one", "two"] },
      { kind: "list", ordered: true, items: ["first"] },
      { kind: "heading", text: "Fuel" },
      { kind: "paragraph", text: "Plenty." },
    ])
  })
  test("bold runs", () => {
    expect(inlineSegments("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ])
  })
})
