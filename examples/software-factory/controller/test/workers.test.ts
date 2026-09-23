import { describe, expect, it } from "vitest"
import {
  createWorkerMap,
  DrafterUnconfiguredError,
  NoWorkerForTargetError,
} from "../src/lib/controller/workers.ts"
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
const B = {
  url: "http://b:4100",
  appRoot: "/srv/b",
  route: "/repair#agent",
  manifestDir: "/srv/b/manifests",
}

describe("createWorkerMap", () => {
  it("makes one client per URL and one reader per entry, lazily", () => {
    const d = deps()
    const map = createWorkerMap(
      { workers: { devkit: A, cli: { ...B, url: A.url }, testing: B } },
      d,
    )
    // Nothing is made at boot: a worker that is down must not decide whether the controller starts.
    expect(d.made).toEqual({ clients: [], builders: [], drafters: [] })
    const devkit = map.forTarget("devkit")
    const cli = map.forTarget("cli")
    const testing = map.forTarget("testing")
    expect(devkit).toMatchObject({
      route: "/build#agent",
      appRoot: "/srv/a",
      manifestDir: "/srv/a/.factory/manifests",
    })
    // Each entry carries the manifest directory its process reads: where `dispatch` writes.
    expect(cli).toMatchObject({
      route: "/repair#agent",
      appRoot: "/srv/b",
      manifestDir: "/srv/b/manifests",
    })
    // `devkit` and `cli` are served by one process: one client between them, two readers
    // (each entry's installation store is its own).
    expect(devkit?.client).toBe(cli?.client)
    expect(testing?.client).not.toBe(devkit?.client)
    expect(d.made.clients).toEqual([A.url, B.url])
    expect(d.made.builders).toEqual(["/srv/a", "/srv/b", "/srv/b"])
    // Asked twice, made once.
    expect(map.forTarget("devkit")?.reader).toBe(devkit?.reader)
    expect(d.made.builders).toHaveLength(3)
    expect(map.forTarget("unknown")).toBeUndefined()
  })

  it("serves a target from its own entry only: there is no wildcard", () => {
    const d = deps()
    const map = createWorkerMap({ workers: { cli: B } }, d)
    expect(map.forTarget("cli")?.appRoot).toBe("/srv/b")
    // Not even an entry literally keyed `*`, nor an inherited property name.
    expect(createWorkerMap({ workers: { "*": A } }, d).forTarget("devkit")).toBeUndefined()
    expect(map.forTarget("constructor")).toBeUndefined()
    expect(d.made.builders).toEqual(["/srv/b"])
  })

  it("has no drafter unless configured, and builds it once when it is", () => {
    const d = deps()
    expect(createWorkerMap({ workers: { devkit: A } }, d).drafter).toBeUndefined()
    const drafterEntry = {
      url: "http://drafter:4200",
      appRoot: "/srv/drafter",
      route: "/intake#agent",
      manifestDir: "/srv/drafter/.factory/manifests",
    }
    const map = createWorkerMap({ workers: { devkit: A }, drafter: drafterEntry }, d)
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
    const shared = createWorkerMap(
      { workers: { devkit: A }, drafter: { ...drafterEntry, url: A.url } },
      d,
    )
    expect(shared.drafter?.client).toBe(shared.forTarget("devkit")?.client)
  })

  it("names the target, and the variables, in its errors", () => {
    expect(new NoWorkerForTargetError("testing").message).toBe("no worker for target testing")
    expect(new DrafterUnconfiguredError().message).toBe(
      "intake is not configured: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT",
    )
  })
})
