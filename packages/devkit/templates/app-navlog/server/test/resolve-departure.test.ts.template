import type { B4ToolContext } from "@b4run/sdk"
import { describe, expect, it, vi } from "vitest"
import resolveDeparture from "../src/tools/resolveDeparture.ts"

const ctx = {} as unknown as B4ToolContext

describe("resolveDeparture", () => {
  it("resolves the pilot's words once, so the weather brief and the navlog agree", async () => {
    // The live demo at 0005Z on 8 Oct: the weather subagent did this sum itself
    // and called "tomorrow 1500Z" 39 hours out. It is the 8th, 15 hours out.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-08T00:05:00Z"))
    try {
      expect(await resolveDeparture({ departure: "tomorrow 1500Z" }, ctx)).toEqual({
        departureUtc: "2026-10-08T15:00:00.000Z",
        hoursAhead: 14.9,
      })
      expect(await resolveDeparture({ departure: "1500Z" }, ctx)).toEqual({
        departureUtc: "2026-10-08T15:00:00.000Z",
        hoursAhead: 14.9,
      })
      expect(await resolveDeparture({ departure: "2026-10-09T15:00:00Z" }, ctx)).toEqual({
        departureUtc: "2026-10-09T15:00:00.000Z",
        hoursAhead: 38.9,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("passes the parser's error through for a time it cannot read", async () => {
    await expect(resolveDeparture({ departure: "next week" }, ctx)).rejects.toThrow(
      /departureTimeUtc must be an ISO 8601 UTC instant/,
    )
  })
})
