import { describe, expect, it } from "vitest"
import { DashboardLocal, InsightLocal } from "./schema.ts"

describe("InsightLocal", () => {
  it("parses a trends insight with a breakdown and applies defaults", () => {
    const result = InsightLocal.parse({
      slug: "pageviews-by-path",
      posthog_id: null,
      kind: "trends",
      name: "Pageviews by path",
      events: [{ event: "$pageview", math: "total" }],
      breakdown: "$pathname",
    })
    expect(result.interval).toBe("day")
    expect(result.date_from).toBe("-30d")
  })

  it("rejects a funnel without steps", () => {
    const result = InsightLocal.safeParse({
      slug: "install",
      posthog_id: null,
      kind: "funnel",
      name: "Install",
    })
    expect(result.success).toBe(false)
  })

  it("accepts a funnel with steps", () => {
    const result = InsightLocal.safeParse({
      slug: "install",
      posthog_id: null,
      kind: "funnel",
      name: "Install",
      steps: [{ event: "a" }, { event: "b" }],
    })
    expect(result.success).toBe(true)
  })

  it("rejects an uppercase slug", () => {
    const result = InsightLocal.safeParse({
      slug: "Bad",
      posthog_id: null,
      kind: "trends",
      name: "x",
      events: [{ event: "a" }],
    })
    expect(result.success).toBe(false)
  })

  it("requires a value for comparison filters but not presence filters", () => {
    const base = { slug: "q", posthog_id: null, kind: "trends", name: "Q" }
    expect(
      InsightLocal.safeParse({
        ...base,
        events: [{ event: "x", properties: [{ key: "k", operator: "exact" }] }],
      }).success,
    ).toBe(false)
    expect(
      InsightLocal.safeParse({
        ...base,
        events: [{ event: "x", properties: [{ key: "k", operator: "is_not_set" }] }],
      }).success,
    ).toBe(true)
  })
})

describe("DashboardLocal", () => {
  it("references insights by string slug", () => {
    const result = DashboardLocal.parse({
      slug: "overview",
      posthog_id: null,
      name: "Overview",
      description: "d",
      tiles: [{ insight: "pageviews-by-path" }],
    })
    expect(result.tiles[0]?.insight).toBe("pageviews-by-path")
    expect(result.tags).toEqual([])
  })

  it("rejects an uppercase slug", () => {
    expect(
      DashboardLocal.safeParse({
        slug: "Bad",
        posthog_id: null,
        name: "x",
        description: "",
        tiles: [],
      }).success,
    ).toBe(false)
  })
})
