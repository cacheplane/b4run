import { describe, expect, it } from "vitest"
import {
  businessMorningAfter,
  isSendWindow,
  pacificCalendarDate,
  pacificMorningOf,
  SEQUENCE_TIME_ZONE,
  STEP_DELAY_BUSINESS_DAYS,
} from "./schedule"

const at = (iso: string) => new Date(iso)

describe("founder sequence schedule", () => {
  it("uses the Pacific time zone and the step delays", () => {
    expect(SEQUENCE_TIME_ZONE).toBe("America/Los_Angeles")
    expect(STEP_DELAY_BUSINESS_DAYS).toEqual({ 2: 3, 3: 5 })
  })

  it("schedules a Monday-noon approval for Tuesday 07:00 PDT", () => {
    expect(businessMorningAfter(at("2026-10-19T19:00:00Z"), 1).toISOString()).toBe(
      "2026-10-20T14:00:00.000Z",
    )
  })

  it("schedules a Friday-evening approval for Monday 07:00", () => {
    expect(businessMorningAfter(at("2026-10-23T03:00:00Z"), 1).toISOString()).toBe(
      "2026-10-23T14:00:00.000Z",
    )
    expect(businessMorningAfter(at("2026-10-24T02:00:00Z"), 1).toISOString()).toBe(
      "2026-10-26T14:00:00.000Z",
    )
  })

  it("keeps 07:00 local across the November DST change", () => {
    expect(businessMorningAfter(at("2026-10-30T18:00:00Z"), 1).toISOString()).toBe(
      "2026-11-02T15:00:00.000Z",
    )
  })

  it("counts three and five business days for steps 2 and 3", () => {
    const anchor = at("2026-10-20T14:05:00Z")
    expect(businessMorningAfter(anchor, STEP_DELAY_BUSINESS_DAYS[2]).toISOString()).toBe(
      "2026-10-23T14:00:00.000Z",
    )
    expect(businessMorningAfter(anchor, STEP_DELAY_BUSINESS_DAYS[3]).toISOString()).toBe(
      "2026-10-27T14:00:00.000Z",
    )
  })

  it.each([[0], [367], [1.5]])("rejects an offset of %s", (offset) => {
    expect(() => businessMorningAfter(at("2026-10-20T14:05:00Z"), offset)).toThrow()
  })

  it("rejects an invalid date", () => {
    expect(() => businessMorningAfter(new Date("nope"), 1)).toThrow()
  })

  it("opens the window only on weekdays during local hour 7", () => {
    expect(isSendWindow(at("2026-10-20T14:00:00Z"))).toBe(true)
    expect(isSendWindow(at("2026-10-20T15:00:00Z"))).toBe(false)
    expect(isSendWindow(at("2026-10-24T14:30:00Z"))).toBe(false)
    expect(isSendWindow(at("2026-11-02T15:30:00Z"))).toBe(true)
  })

  it("reports the Pacific calendar date across UTC midnight", () => {
    expect(pacificCalendarDate(at("2026-10-21T05:00:00Z"))).toEqual({
      date: "2026-10-20",
      weekday: true,
    })
  })

  it("returns 07:00 Pacific on the Pacific date, in either offset and across a DST change day", () => {
    expect(pacificMorningOf(at("2026-10-22T14:35:00Z")).toISOString()).toBe(
      "2026-10-22T14:00:00.000Z",
    )
    // 23:30 PDT on Wednesday is still Wednesday in Pacific time.
    expect(pacificMorningOf(at("2026-10-22T06:30:00Z")).toISOString()).toBe(
      "2026-10-21T14:00:00.000Z",
    )
    expect(pacificMorningOf(at("2026-11-03T15:20:00Z")).toISOString()).toBe(
      "2026-11-03T15:00:00.000Z",
    )
    // DST starts 2027-03-14 and ends 2026-11-01: both days still resolve to local 07:00.
    expect(pacificMorningOf(at("2027-03-14T20:00:00Z")).toISOString()).toBe(
      "2027-03-14T14:00:00.000Z",
    )
    expect(pacificMorningOf(at("2026-11-01T20:00:00Z")).toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    )
  })
})
