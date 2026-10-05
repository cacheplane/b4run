import { describe, expect, test } from "vitest"
import { formatHeading, formatHhmm, formatUtcHhmm } from "./format"

describe("format", () => {
  test("headings are three digits", () => {
    expect(formatHeading(5)).toBe("005")
    expect(formatHeading(168)).toBe("168")
    expect(formatHeading(360)).toBe("360")
  })
  test("minutes become h:mm", () => {
    expect(formatHhmm(44)).toBe("0:44")
    expect(formatHhmm(125)).toBe("2:05")
  })
  test("minutes round before splitting, so 59.6 is 1:00 and not 0:60", () => {
    expect(formatHhmm(59.6)).toBe("1:00")
    expect(formatHhmm(119.5)).toBe("2:00")
  })
  test("ISO instants become HHMMZ", () => {
    expect(formatUtcHhmm("2026-10-05T14:07:00.000Z")).toBe("1407Z")
  })
})
