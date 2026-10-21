import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { PosthogClient } from "./client.ts"
import {
  applyPlan,
  computePlan,
  formatPlan,
  type RemoteDashboard,
  type RemoteInsight,
  type SyncClient,
  toPostHogInsight,
  toSyncClient,
} from "./sync.ts"

async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "posthog-tools-"))
  await mkdir(join(dir, "dashboards"), { recursive: true })
  await mkdir(join(dir, "insights"), { recursive: true })
  return dir
}

function fakeClient(
  remote: { dashboards?: RemoteDashboard[]; insights?: RemoteInsight[] } = {},
): SyncClient {
  return {
    listDashboards: async () => remote.dashboards ?? [],
    listInsights: async () => remote.insights ?? [],
    createDashboard: async (body) => ({ ...body, id: 1000, name: String(body["name"]) }),
    createInsight: async (body) => ({ ...body, id: 2000, name: String(body["name"]) }),
    updateDashboard: async (id, body) => ({ ...body, id, name: String(body["name"] ?? "") }),
    updateInsight: async (id, body) => ({ ...body, id, name: String(body["name"] ?? "") }),
    deleteDashboard: async () => undefined,
    deleteInsight: async () => undefined,
  }
}

const insight = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    slug: "i",
    posthog_id: null,
    kind: "trends",
    name: "I",
    events: [{ event: "$pageview" }],
    ...over,
  })

describe("computePlan", () => {
  it("plans create for a local insight with no remote match", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "insights/i.json"), insight())
    const plan = await computePlan({ root, client: fakeClient() })
    expect(plan.create).toHaveLength(1)
    expect(plan.update).toHaveLength(0)
    expect(formatPlan(plan)).toBe("[create] insight i")
  })

  it("plans update when posthog_id matches a remote", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "insights/i.json"), insight({ posthog_id: 42 }))
    const plan = await computePlan({
      root,
      client: fakeClient({ insights: [{ id: 42, name: "I" }] }),
    })
    expect(plan.update).toHaveLength(1)
    expect(plan.update[0]?.remoteId).toBe(42)
    expect(formatPlan(plan)).toBe("[update] insight i")
  })

  it("falls back to a unique name match", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "insights/i.json"), insight())
    const plan = await computePlan({
      root,
      client: fakeClient({ insights: [{ id: 77, name: "I" }] }),
    })
    expect(plan.update[0]?.remoteId).toBe(77)
  })

  it("plans orphan for a remote with no local", async () => {
    const root = await fixtureRoot()
    const plan = await computePlan({
      root,
      client: fakeClient({ insights: [{ id: 9, name: "Stray" }] }),
    })
    expect(plan.orphan).toHaveLength(1)
    expect(formatPlan(plan)).toBe("[orphan] insight Stray (#9)")
  })

  it("names the file in invalid JSON errors", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "insights/bad.json"), JSON.stringify({ slug: "BAD" }))
    await expect(computePlan({ root, client: fakeClient() })).rejects.toThrow(/insights\/bad\.json/)
  })
})

describe("applyPlan", () => {
  it("creates insights before dashboards, resolves tile slugs and writes ids back", async () => {
    const root = await fixtureRoot()
    await writeFile(
      join(root, "dashboards/d.json"),
      JSON.stringify({
        slug: "d",
        posthog_id: null,
        name: "D",
        description: "",
        tiles: [{ insight: "i" }],
      }),
    )
    await writeFile(join(root, "insights/i.json"), insight())
    const calls: string[] = []
    const memberships: Array<[number, unknown]> = []
    const client: SyncClient = {
      ...fakeClient(),
      createInsight: async (body) => {
        calls.push("insight")
        return { ...body, id: 2001, name: "I" }
      },
      createDashboard: async (body) => {
        calls.push("dashboard")
        return { ...body, id: 1001, name: "D" }
      },
      updateInsight: async (id, body) => {
        memberships.push([id, body["dashboards"]])
        return { id, name: "I" }
      },
    }
    const plan = await computePlan({ root, client })
    const result = await applyPlan({ root, client, plan })
    expect(result.failed).toBe(0)
    expect(calls).toEqual(["insight", "dashboard"])
    expect(memberships).toEqual([[2001, [1001]]])
    const written = JSON.parse(await readFile(join(root, "insights/i.json"), "utf8"))
    expect(written.posthog_id).toBe(2001)
    const dash = JSON.parse(await readFile(join(root, "dashboards/d.json"), "utf8"))
    expect(dash.posthog_id).toBe(1001)
  })

  it("throws on a dashboard tile with an unknown insight slug", async () => {
    const root = await fixtureRoot()
    await writeFile(
      join(root, "dashboards/d.json"),
      JSON.stringify({
        slug: "d",
        posthog_id: null,
        name: "D",
        description: "",
        tiles: [{ insight: "missing" }],
      }),
    )
    const client = fakeClient()
    const plan = await computePlan({ root, client })
    await expect(applyPlan({ root, client, plan })).rejects.toThrow(/missing/)
  })

  it("deletes orphans only when deleteOrphans is true", async () => {
    const root = await fixtureRoot()
    const deleted: number[] = []
    const client: SyncClient = {
      ...fakeClient({ dashboards: [{ id: 999, name: "Stray" }] }),
      deleteDashboard: async (id) => {
        deleted.push(id)
      },
    }
    const plan = await computePlan({ root, client })
    await applyPlan({ root, client, plan })
    expect(deleted).toEqual([])
    await applyPlan({ root, client, plan, deleteOrphans: true })
    expect(deleted).toEqual([999])
  })

  it("does not touch disk or remote on dry run", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "insights/i.json"), insight())
    const before = await readFile(join(root, "insights/i.json"), "utf8")
    const client = fakeClient()
    const plan = await computePlan({ root, client })
    await applyPlan({ root, client, plan, dryRun: true })
    expect(await readFile(join(root, "insights/i.json"), "utf8")).toBe(before)
  })

  it("preserves manual dashboard memberships when wiring", async () => {
    const root = await fixtureRoot()
    await writeFile(
      join(root, "dashboards/d.json"),
      JSON.stringify({
        slug: "d",
        posthog_id: 10,
        name: "D",
        description: "",
        tiles: [{ insight: "i" }],
      }),
    )
    await writeFile(join(root, "insights/i.json"), insight({ posthog_id: 1 }))
    const writes: Array<[number, unknown]> = []
    const client: SyncClient = {
      ...fakeClient({
        dashboards: [{ id: 10, name: "D" }],
        insights: [
          { id: 1, name: "I", dashboards: [99] },
          { id: 2, name: "Stale", dashboards: [10, 99] },
        ],
      }),
      updateInsight: async (id, body) => {
        if (body["dashboards"]) writes.push([id, body["dashboards"]])
        return { id, name: "I" }
      },
    }
    const result = await applyPlan({ root, client, plan: await computePlan({ root, client }) })
    expect(result.failed).toBe(0)
    expect(writes).toEqual([
      [1, [99, 10]],
      [2, [99]],
    ])
  })
})

describe("toPostHogInsight", () => {
  it("maps a trends insight with a breakdown", () => {
    const out = toPostHogInsight({
      slug: "x",
      posthog_id: null,
      kind: "trends",
      name: "X",
      events: [{ event: "$pageview", math: "total" }],
      breakdown: "$pathname",
      interval: "day",
      date_from: "-30d",
    })
    expect(out).toMatchObject({
      query: {
        kind: "InsightVizNode",
        source: {
          kind: "TrendsQuery",
          series: [{ kind: "EventsNode", event: "$pageview", math: "total" }],
          breakdownFilter: { breakdown: "$pathname", breakdown_type: "event" },
          interval: "day",
          dateRange: { date_from: "-30d" },
        },
      },
    })
  })

  it("maps a funnel insight", () => {
    const out = toPostHogInsight({
      slug: "f",
      posthog_id: null,
      kind: "funnel",
      name: "F",
      steps: [{ event: "a" }, { event: "b" }],
      window_minutes: 30,
      interval: "day",
      date_from: "-30d",
    }) as { query: { source: Record<string, unknown> } }
    expect(out.query.source["kind"]).toBe("FunnelsQuery")
    expect(out.query.source["funnelsFilter"]).toMatchObject({ funnelWindowInterval: 30 })
  })
})

describe("toSyncClient", () => {
  it("maps methods onto the REST paths", async () => {
    const seen: string[] = []
    const client: PosthogClient = {
      get: async <T>(path: string, query?: Record<string, string>) => {
        seen.push(`GET ${path}?${new URLSearchParams(query).toString()}`)
        return { results: [{ id: 1, name: "a" }] } as T
      },
      post: async <T>(path: string) => {
        seen.push(`POST ${path}`)
        return { id: 1, name: "a" } as T
      },
      patch: async <T>(path: string) => {
        seen.push(`PATCH ${path}`)
        return { id: 1, name: "a" } as T
      },
      delete: async (path) => {
        seen.push(`DELETE ${path}`)
      },
    }
    const sync = toSyncClient(client)
    expect(await sync.listInsights()).toEqual([{ id: 1, name: "a" }])
    await sync.listDashboards()
    await sync.createInsight({})
    await sync.createDashboard({})
    await sync.updateInsight(5, {})
    await sync.updateDashboard(6, {})
    await sync.deleteInsight(5)
    await sync.deleteDashboard(6)
    expect(seen).toEqual([
      "GET /insights/?limit=1000",
      "GET /dashboards/?limit=1000",
      "POST /insights/",
      "POST /dashboards/",
      "PATCH /insights/5/",
      "PATCH /dashboards/6/",
      "DELETE /insights/5/",
      "DELETE /dashboards/6/",
    ])
  })
})
