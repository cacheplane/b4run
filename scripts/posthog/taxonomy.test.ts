import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { EVENT_CONTRACT } from "./contract.ts"
import { DashboardLocal, InsightLocal } from "./schema.ts"

const root = dirname(fileURLToPath(import.meta.url))

function load<T>(dir: string, parse: (json: unknown) => T): Array<{ file: string; data: T }> {
  return readdirSync(join(root, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file: `${dir}/${file}`,
      data: parse(JSON.parse(readFileSync(join(root, dir, file), "utf8"))),
    }))
}

const insights = load("insights", (json) => InsightLocal.parse(json))
const dashboards = load("dashboards", (json) => DashboardLocal.parse(json))

describe("insight and dashboard definitions", () => {
  it("defines seven insights and one dashboard", () => {
    expect(insights).toHaveLength(7)
    expect(dashboards).toHaveLength(1)
  })

  it("names the file after the slug", () => {
    for (const { file, data } of [...insights, ...dashboards]) {
      expect(file).toMatch(new RegExp(`/${data.slug}\\.json$`))
    }
  })

  it("only references events in the contract", () => {
    for (const { file, data } of insights) {
      const names = [...(data.events ?? []), ...(data.steps ?? [])].map((e) => e.event)
      expect(names.length, file).toBeGreaterThan(0)
      for (const name of names) expect(Object.keys(EVENT_CONTRACT), file).toContain(name)
    }
  })

  it("breaks down only by properties allowed for every event in the insight", () => {
    for (const { file, data } of insights) {
      if (data.breakdown === undefined) continue
      for (const { event } of data.events ?? []) {
        expect(EVENT_CONTRACT[event]?.allowedBreakdowns, `${file} ${event}`).toContain(
          data.breakdown,
        )
      }
    }
  })

  it("gives every insight a description and a posthog_id that is null or a positive integer", () => {
    for (const { file, data } of [...insights, ...dashboards]) {
      expect(data.description, file).toBeTruthy()
      const id = data.posthog_id
      expect(id === null || (Number.isInteger(id) && id > 0), file).toBe(true)
    }
  })

  it("has an insight file for every dashboard tile", () => {
    const slugs = new Set(insights.map(({ data }) => data.slug))
    for (const { data } of dashboards) {
      for (const tile of data.tiles) expect(slugs, tile.insight).toContain(tile.insight)
    }
  })
})
