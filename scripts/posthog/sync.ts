import { readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { z } from "zod"
import type { PosthogClient } from "./client.js"
import { DashboardLocal, InsightLocal } from "./schema.js"

export interface RemoteDashboard {
  id: number
  name: string
  tags?: string[]
}

export interface RemoteInsight {
  id: number
  name: string
  dashboards?: number[]
}

type Body = Record<string, unknown>

export interface SyncClient {
  listDashboards(): Promise<RemoteDashboard[]>
  listInsights(): Promise<RemoteInsight[]>
  createDashboard(body: Body): Promise<RemoteDashboard>
  createInsight(body: Body): Promise<RemoteInsight>
  updateDashboard(id: number, body: Body): Promise<RemoteDashboard>
  updateInsight(id: number, body: Body): Promise<RemoteInsight>
  deleteDashboard(id: number): Promise<void>
  deleteInsight(id: number): Promise<void>
}

export function toSyncClient(client: PosthogClient): SyncClient {
  const list = async <T>(path: string): Promise<T[]> => {
    const page = await client.get<{ results: T[] }>(path, { limit: "1000" })
    if (!Array.isArray(page.results)) throw new Error(`Invalid PostHog list response for ${path}`)
    return page.results
  }
  return {
    listDashboards: () => list<RemoteDashboard>("/dashboards/"),
    listInsights: () => list<RemoteInsight>("/insights/"),
    createDashboard: (body) => client.post<RemoteDashboard>("/dashboards/", body),
    createInsight: (body) => client.post<RemoteInsight>("/insights/", body),
    updateDashboard: (id, body) => client.patch<RemoteDashboard>(`/dashboards/${id}/`, body),
    updateInsight: (id, body) => client.patch<RemoteInsight>(`/insights/${id}/`, body),
    deleteDashboard: (id) => client.delete(`/dashboards/${id}/`),
    deleteInsight: (id) => client.delete(`/insights/${id}/`),
  }
}

export type Kind = "dashboard" | "insight"

export type PlanItem =
  | { kind: "dashboard"; local: DashboardLocal; remoteId?: number; path: string }
  | { kind: "insight"; local: InsightLocal; remoteId?: number; path: string }

export interface OrphanItem {
  kind: Kind
  remote: { id: number; name: string }
}

export interface SyncPlan {
  create: PlanItem[]
  update: PlanItem[]
  orphan: OrphanItem[]
}

async function loadLocalDir<T>(
  root: string,
  subdir: string,
  schema: z.ZodType<T>,
): Promise<Array<{ data: T; path: string }>> {
  let files: string[]
  try {
    files = (await readdir(join(root, subdir))).filter((f) => f.endsWith(".json")).sort()
  } catch {
    return []
  }
  const out: Array<{ data: T; path: string }> = []
  for (const f of files) {
    const path = join(subdir, f)
    const json: unknown = JSON.parse(await readFile(join(root, path), "utf8"))
    const result = schema.safeParse(json)
    if (!result.success) {
      throw new Error(`${path}: ${JSON.stringify(result.error.issues)}`)
    }
    out.push({ data: result.data, path })
  }
  return out
}

function matchRemote<R extends { id: number; name: string }>(
  local: { posthog_id: number | null; name: string },
  remotes: R[],
): { remote: R | null; ambiguous: R[] } {
  if (local.posthog_id !== null) {
    return { remote: remotes.find((r) => r.id === local.posthog_id) ?? null, ambiguous: [] }
  }
  const named = remotes.filter((r) => r.name === local.name)
  if (named.length === 1) return { remote: named[0] ?? null, ambiguous: [] }
  return { remote: null, ambiguous: named }
}

export async function computePlan({
  root,
  client,
}: {
  root: string
  client: SyncClient
}): Promise<SyncPlan> {
  const localDashboards = await loadLocalDir(root, "dashboards", DashboardLocal)
  const localInsights = await loadLocalDir(root, "insights", InsightLocal)
  const remoteDashboards = await client.listDashboards()
  const remoteInsights = await client.listInsights()

  const plan: SyncPlan = { create: [], update: [], orphan: [] }

  const reconcile = <
    L extends { posthog_id: number | null; name: string },
    R extends { id: number; name: string },
  >(
    kind: Kind,
    locals: Array<{ data: L; path: string }>,
    remotes: R[],
    toItem: (data: L, path: string, remoteId?: number) => PlanItem,
  ): void => {
    const matched = new Set<number>()
    for (const { data, path } of locals) {
      const { remote, ambiguous } = matchRemote(data, remotes)
      if (remote) {
        plan.update.push(toItem(data, path, remote.id))
        matched.add(remote.id)
      } else {
        plan.create.push(toItem(data, path))
        for (const r of ambiguous) {
          plan.orphan.push({ kind, remote: { id: r.id, name: r.name } })
          matched.add(r.id)
        }
      }
    }
    for (const r of remotes) {
      if (!matched.has(r.id)) plan.orphan.push({ kind, remote: { id: r.id, name: r.name } })
    }
  }

  reconcile("dashboard", localDashboards, remoteDashboards, (local, path, remoteId) => ({
    kind: "dashboard",
    local,
    path,
    ...(remoteId !== undefined ? { remoteId } : {}),
  }))
  reconcile("insight", localInsights, remoteInsights, (local, path, remoteId) => ({
    kind: "insight",
    local,
    path,
    ...(remoteId !== undefined ? { remoteId } : {}),
  }))

  return plan
}

export function formatPlan(plan: SyncPlan): string {
  const lines: string[] = []
  for (const item of plan.create) lines.push(`[create] ${item.kind} ${item.local.slug}`)
  for (const item of plan.update) lines.push(`[update] ${item.kind} ${item.local.slug}`)
  for (const item of plan.orphan) {
    lines.push(`[orphan] ${item.kind} ${item.remote.name} (#${item.remote.id})`)
  }
  return lines.join("\n")
}

export interface ApplyResult {
  applied: number
  failed: number
  errors: Array<{ kind: Kind; slug: string; error: string }>
}

export interface ApplyOptions {
  root: string
  client: SyncClient
  plan: SyncPlan
  dryRun?: boolean
  deleteOrphans?: boolean
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  await rename(tmpPath, path)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Fail before any remote call when a tile names an insight slug that no local
// insight file defines. Tiles are not sent to PostHog (read-only there);
// membership is wired through each insight's `dashboards` field afterwards.
function assertTilesDefined(plan: SyncPlan): void {
  const defined = new Set<string>()
  for (const item of [...plan.create, ...plan.update]) {
    if (item.kind === "insight") defined.add(item.local.slug)
  }
  for (const item of [...plan.create, ...plan.update]) {
    if (item.kind !== "dashboard") continue
    for (const tile of item.local.tiles) {
      if (!defined.has(tile.insight)) {
        throw new Error(
          `dashboards/${item.local.slug}.json references unknown insight slug "${tile.insight}"`,
        )
      }
    }
  }
}

// Returns the first tile slug whose insight id is not known (its create or
// update failed), or undefined when every tile resolves.
function firstUnresolvedTile(
  dashboard: DashboardLocal,
  known: Map<string, number>,
): string | undefined {
  return dashboard.tiles.find((tile) => !known.has(tile.insight))?.insight
}

// Maps the local insight shape to PostHog's query schema (InsightVizNode).
export function toPostHogInsight(local: InsightLocal): unknown {
  const base = { name: local.name, description: local.description ?? "" }

  if (local.kind === "funnel") {
    return {
      ...base,
      query: {
        kind: "InsightVizNode",
        source: {
          kind: "FunnelsQuery",
          series: (local.steps ?? []).map((s) => ({
            kind: "EventsNode",
            event: s.event,
            name: s.name ?? s.event,
            math: "total",
          })),
          dateRange: { date_from: local.date_from },
          funnelsFilter: {
            funnelWindowInterval: local.window_minutes ?? 60,
            funnelWindowIntervalUnit: "minute",
          },
        },
      },
    }
  }

  const source: Record<string, unknown> = {
    kind: "TrendsQuery",
    series: (local.events ?? []).map((e) => ({
      kind: "EventsNode",
      event: e.event,
      name: e.name ?? e.event,
      ...(e.name ? { custom_name: e.name } : {}),
      math: e.math ?? "total",
      properties: (e.properties ?? []).map((p) => ({
        key: p.key,
        ...(p.value !== undefined ? { value: p.value } : {}),
        operator: p.operator,
        type: "event",
      })),
    })),
    dateRange: { date_from: local.date_from },
    interval: local.interval,
    trendsFilter: {},
  }
  if (local.breakdown) {
    source["breakdownFilter"] = {
      breakdown_type: "event",
      breakdown: local.breakdown,
      ...(local.breakdown_limit !== undefined ? { breakdown_limit: local.breakdown_limit } : {}),
    }
  }
  return { ...base, query: { kind: "InsightVizNode", source } }
}

// Tiles are read-only on PostHog dashboards, so they are not part of the body.
function toPostHogDashboard(local: DashboardLocal): Body {
  return { name: local.name, description: local.description, tags: local.tags }
}

export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  const { root, client, plan, dryRun = false, deleteOrphans = false } = options
  const result: ApplyResult = { applied: 0, failed: 0, errors: [] }
  const insightSlugToId = new Map<string, number>()
  const dashboardSlugToId = new Map<string, number>()
  const createdInsightIds = new Set<number>()

  for (const item of plan.update) {
    if (item.remoteId === undefined) continue
    if (item.kind === "insight") insightSlugToId.set(item.local.slug, item.remoteId)
    else dashboardSlugToId.set(item.local.slug, item.remoteId)
  }

  const skippedDashboards = new Set<string>()
  if (!dryRun) assertTilesDefined(plan)

  const fail = (kind: Kind, slug: string, err: unknown): void => {
    result.failed += 1
    result.errors.push({ kind, slug, error: message(err) })
  }

  // Insights first so dashboard tiles can resolve to ids.
  for (const kind of ["insight", "dashboard"] as const) {
    const creates = plan.create.filter((p) => p.kind === kind)
    const updates = plan.update.filter((p) => p.kind === kind)
    if (dryRun) continue

    for (const item of creates) {
      if (item.kind === "dashboard") {
        const missing = firstUnresolvedTile(item.local, insightSlugToId)
        if (missing !== undefined) {
          skippedDashboards.add(item.local.slug)
          fail(
            item.kind,
            item.local.slug,
            new Error(`insight "${missing}" was not created or updated`),
          )
          continue
        }
      }
      try {
        const created =
          item.kind === "insight"
            ? await client.createInsight(toPostHogInsight(item.local) as Body)
            : await client.createDashboard(toPostHogDashboard(item.local))
        if (item.kind === "insight") {
          insightSlugToId.set(item.local.slug, created.id)
          createdInsightIds.add(created.id)
        } else {
          dashboardSlugToId.set(item.local.slug, created.id)
        }
        await atomicWriteJson(join(root, item.path), { ...item.local, posthog_id: created.id })
        result.applied += 1
      } catch (err) {
        fail(item.kind, item.local.slug, err)
      }
    }

    for (const item of updates) {
      if (item.remoteId === undefined) continue
      if (item.kind === "dashboard") {
        const missing = firstUnresolvedTile(item.local, insightSlugToId)
        if (missing !== undefined) {
          skippedDashboards.add(item.local.slug)
          fail(
            item.kind,
            item.local.slug,
            new Error(`insight "${missing}" was not created or updated`),
          )
          continue
        }
      }
      try {
        if (item.kind === "insight") {
          await client.updateInsight(item.remoteId, toPostHogInsight(item.local) as Body)
        } else {
          await client.updateDashboard(item.remoteId, toPostHogDashboard(item.local))
        }
        if (item.local.posthog_id !== item.remoteId) {
          await atomicWriteJson(join(root, item.path), { ...item.local, posthog_id: item.remoteId })
        }
        result.applied += 1
      } catch (err) {
        fail(item.kind, item.local.slug, err)
      }
    }
  }

  // Reconcile memberships only for repository-managed dashboards; keep every
  // other membership (manual dashboards, untracked insights) untouched.
  if (!dryRun && dashboardSlugToId.size > 0) {
    try {
      const localDashboards = await loadLocalDir(root, "dashboards", DashboardLocal)
      const managed = new Set(
        [...dashboardSlugToId].filter(([slug]) => !skippedDashboards.has(slug)).map(([, id]) => id),
      )
      const desired = new Map<number, number[]>()
      for (const { data: dashboard } of localDashboards) {
        const dashboardId = dashboardSlugToId.get(dashboard.slug)
        if (dashboardId === undefined || skippedDashboards.has(dashboard.slug)) continue
        for (const tile of dashboard.tiles) {
          const insightId = insightSlugToId.get(tile.insight)
          if (insightId === undefined) throw new Error(`Unknown insight ${tile.insight}`)
          const memberships = desired.get(insightId) ?? []
          if (!memberships.includes(dashboardId)) memberships.push(dashboardId)
          desired.set(insightId, memberships)
        }
      }
      const current = new Map((await client.listInsights()).map((i) => [i.id, i]))
      for (const id of desired.keys()) {
        if (!current.has(id)) {
          if (!createdInsightIds.has(id))
            throw new Error(`Cannot read memberships for insight ${id}`)
          current.set(id, { id, name: `insight ${id}`, dashboards: [] })
        }
      }
      for (const insight of current.values()) {
        if (!Array.isArray(insight.dashboards)) {
          throw new Error(`Cannot read memberships for insight ${insight.id}`)
        }
        const before = insight.dashboards
        const after = [
          ...new Set([
            ...before.filter((id) => !managed.has(id)),
            ...(desired.get(insight.id) ?? []),
          ]),
        ]
        if (before.length === after.length && before.every((id) => after.includes(id))) continue
        try {
          await client.updateInsight(insight.id, { dashboards: after })
        } catch (err) {
          fail("insight", `${insight.name} (wiring)`, err)
        }
      }
    } catch (err) {
      fail("dashboard", "(wiring)", err)
    }
  }

  if (deleteOrphans && !dryRun) {
    for (const item of plan.orphan) {
      try {
        if (item.kind === "insight") await client.deleteInsight(item.remote.id)
        else await client.deleteDashboard(item.remote.id)
      } catch (err) {
        fail(item.kind, `(orphan id=${item.remote.id})`, err)
      }
    }
  }

  return result
}
