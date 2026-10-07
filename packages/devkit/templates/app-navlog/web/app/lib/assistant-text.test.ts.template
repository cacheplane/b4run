import { describe, expect, test } from "vitest"
import { inlineSegments, parsePlanningAnswer, stripToolEchoes, textBlocks } from "./assistant-text"

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

describe("parsePlanningAnswer", () => {
  const ANSWER = `recall({ query: "profile" })
Bottom line: CAUTION — the freezing level (4,000 ft) is below the 5,500 ft cruise.

**Watch for:**
- Icing above 4,000 ft
- Gusts at KDLH

Numbers:
- 142 nm, 1:12, 10.1 gal burned
Assumptions: 2400 RPM, standard temperature`

  test("reads the bottom line's verdict and the sections in order", () => {
    const answer = parsePlanningAnswer(ANSWER)
    expect(answer?.verdict).toEqual({
      level: "CAUTION",
      reason: "The freezing level (4,000 ft) is below the 5,500 ft cruise.",
    })
    expect(answer?.sections).toEqual([
      { title: "Watch for", items: ["Icing above 4,000 ft", "Gusts at KDLH"] },
      { title: "Numbers", items: ["142 nm, 1:12, 10.1 gal burned"] },
      { title: "Assumptions", items: ["2400 RPM, standard temperature"] },
    ])
  })
  test("null for an answer without a bottom line", () => {
    expect(parsePlanningAnswer("KSTP and KRST are VFR. 66 nm, 33 minutes.")).toBeNull()
  })
  test("the structured answer has no closing when it ends on its sections", () => {
    expect(parsePlanningAnswer(ANSWER)).not.toHaveProperty("closing")
  })

  describe("the closing line", () => {
    const CLOSING =
      "Would you like me to file the VFR flight plan now, try a different altitude, or re-brief closer to departure?"
    const answer = (bullet: (i: number) => string, gap: string) =>
      [
        "Bottom line: GO — VFR the whole way.",
        "Watch for:",
        `${bullet(1)}Gusts at KDLH`,
        "Assumptions:",
        `${bullet(1)}2400 RPM`,
        `${bullet(2)}Standard temperature`,
        ...(gap === "" ? [] : [""]),
        CLOSING,
      ].join("\n")
    const variants: readonly [string, (i: number) => string][] = [
      ["-", () => "- "],
      ["*", () => "* "],
      ["•", () => "• "],
      ["numbered", (i) => `${i}. `],
      ["numbered with )", (i) => `${i}) `],
    ]
    for (const [name, bullet] of variants) {
      for (const gap of ["", "blank"]) {
        test(`${name} bullets, ${gap === "" ? "no blank line" : "a blank line"} before it`, () => {
          const parsed = parsePlanningAnswer(answer(bullet, gap))
          expect(parsed?.sections).toEqual([
            { title: "Watch for", items: ["Gusts at KDLH"] },
            { title: "Assumptions", items: ["2400 RPM", "Standard temperature"] },
          ])
          expect(parsed?.closing).toBe(CLOSING)
        })
      }
    }
    test("a bold closing question", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nAssumptions:\n- 2400 RPM\n\n**Shall I file it now?**",
      )
      expect(parsed?.sections).toEqual([{ title: "Assumptions", items: ["2400 RPM"] }])
      expect(parsed?.closing).toBe("Shall I file it now?")
    })
    test("a plain paragraph after the last bullets, then the question, in order", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nAssumptions:\n- 2400 RPM\n\nRecheck the weather before you go.\nWant me to file it?",
      )
      expect(parsed?.sections).toEqual([{ title: "Assumptions", items: ["2400 RPM"] }])
      expect(parsed?.closing).toBe("Recheck the weather before you go. Want me to file it?")
    })
    test("a next-step question written as a bullet, or mid-answer, is still the closing", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nWatch for:\n- Gusts\n- Would you like a lower altitude?\nNumbers:\n- 62 nm",
      )
      expect(parsed?.sections).toEqual([
        { title: "Watch for", items: ["Gusts"] },
        { title: "Numbers", items: ["62 nm"] },
      ])
      expect(parsed?.closing).toBe("Would you like a lower altitude?")
    })
    test("a section the question emptied is dropped", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nNumbers:\n- 62 nm\nAssumptions:\nWould you like me to file?",
      )
      expect(parsed?.sections).toEqual([{ title: "Numbers", items: ["62 nm"] }])
      expect(parsed?.closing).toBe("Would you like me to file?")
    })
    test("a section written as plain lines keeps them; only a trailing question leaves", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nNumbers:\n62 nm\n0:33 ETE\n\nReady to file?",
      )
      expect(parsed?.sections).toEqual([{ title: "Numbers", items: ["62 nm", "0:33 ETE"] }])
      expect(parsed?.closing).toBe("Ready to file?")
    })
    test("an indented continuation of the last bullet stays in it", () => {
      const parsed = parsePlanningAnswer(
        "Bottom line: GO — fine.\nAssumptions:\n- 2400 RPM, standard\n  temperature",
      )
      expect(parsed?.sections).toEqual([
        { title: "Assumptions", items: ["2400 RPM, standard", "temperature"] },
      ])
      expect(parsed).not.toHaveProperty("closing")
    })
    test("a question right under the bottom line, with no sections", () => {
      const parsed = parsePlanningAnswer("Bottom line: GO — fine.\nShould I file it?")
      expect(parsed?.bottomLine).toBe("GO — fine.")
      expect(parsed?.closing).toBe("Should I file it?")
    })
  })

  test("a bottom line without a verdict word keeps its text and a null verdict", () => {
    expect(parsePlanningAnswer("**Bottom line:** looks fine")).toEqual({
      verdict: null,
      bottomLine: "looks fine",
      sections: [],
    })
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
