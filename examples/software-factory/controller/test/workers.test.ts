import { describe, expect, it } from "vitest"
import { createWorkerMap, DrafterUnconfiguredError } from "../src/lib/controller/workers.ts"
import type { WorkerClient } from "../src/lib/worker/client.ts"
import type { WorkspaceReader } from "../src/lib/worker/workspace-reader.ts"

const client = (url: string) => ({ url }) as unknown as WorkerClient
const reader = (label: string) => ({ label }) as unknown as WorkspaceReader

function deps() {
  const made = { clients: [] as string[], builders: [] as string[], drafters: [] as string[] }
  return {
    made,
    createClient: (url: string) => {
      made.clients.push(url)
      return client(url)
    },
    createBuilderReader: (entry: { appRoot: string }) => {
      made.builders.push(entry.appRoot)
      return reader(entry.appRoot)
    },
    createDrafterReader: (entry: { appRoot: string }) => {
      made.drafters.push(entry.appRoot)
      return reader(entry.appRoot)
    },
  }
}

const A = {
  url: "http://a:4100",
  appRoot: "/srv/a",
  route: "/build#agent",
  manifestDir: "/srv/a/.factory/manifests",
}

describe("createWorkerMap", () => {
  it("serves every target from the one builder: one client and one reader, lazily", () => {
    const d = deps()
    const map = createWorkerMap({ builder: A }, d)
    // Nothing is made at boot: a worker that is down must not decide whether the controller starts.
    expect(d.made).toEqual({ clients: [], builders: [], drafters: [] })
    const devkit = map.forTarget("devkit")
    const cli = map.forTarget("cli")
    expect(devkit).toMatchObject({
      route: "/build#agent",
      appRoot: "/srv/a",
      manifestDir: "/srv/a/.factory/manifests",
    })
    // Any target, at any pin: each work order's manifest carries its own image, policy and
    // permissions, so the builder is the same for all of them.
    expect(map.forTarget("a-target-nobody-configured")).toMatchObject({ appRoot: "/srv/a" })
    expect(cli?.client).toBe(devkit?.client)
    expect(cli?.reader).toBe(devkit?.reader)
    expect(d.made.clients).toEqual([A.url])
    expect(d.made.builders).toEqual(["/srv/a"])
  })

  it("has no drafter unless configured, and builds it once when it is", () => {
    const d = deps()
    expect(createWorkerMap({ builder: A }, d).drafter).toBeUndefined()
    const drafterEntry = {
      url: "http://drafter:4200",
      appRoot: "/srv/drafter",
      route: "/intake#agent",
      manifestDir: "/srv/drafter/.factory/manifests",
    }
    const map = createWorkerMap({ builder: A, drafter: drafterEntry }, d)
    expect(d.made.drafters).toEqual([])
    const drafter = map.drafter
    expect(drafter).toMatchObject({
      route: "/intake#agent",
      manifestDir: "/srv/drafter/.factory/manifests",
    })
    expect(map.drafter).toBe(drafter)
    expect(d.made.drafters).toEqual(["/srv/drafter"])
    expect(d.made.clients).toEqual(["http://drafter:4200"])
    // A drafter at the builder's URL shares the builder's client.
    const shared = createWorkerMap({ builder: A, drafter: { ...drafterEntry, url: A.url } }, d)
    expect(shared.drafter?.client).toBe(shared.forTarget("devkit")?.client)
  })

  it("names the variables in its errors", () => {
    expect(new DrafterUnconfiguredError().message).toBe(
      "intake is not configured: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT",
    )
  })
})
