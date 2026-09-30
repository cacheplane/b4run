import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientToolDefinition } from "@b4run/core"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it } from "vitest"
import {
  __resetRouteLoadCachesForTests,
  materializeResolvedRouteGraph,
  prepareRouteExecution,
} from "../src/lib/runtime/execute-route.ts"

/**
 * Client-provided tools at route preparation (cacheplane/b4run#743): each
 * client definition becomes a per-run `client_<name>` stub on an agent route,
 * the `client_` prefix is closed to authored and capability tools, and a
 * preparation that carries client tools never shares a compiled graph with
 * one that does not.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __resetRouteLoadCachesForTests()
})

const OPEN_PANEL: ClientToolDefinition = {
  name: "openPanel",
  description: "Open",
  parameters: { type: "object", properties: {} },
}

const AGENT_ROUTE =
  'import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "t" })\n'

async function fixtureApp(files: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-client-tools-prep-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const all: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "client-tools-prep-fixture", "type": "module" }\n',
    ...files,
  }
  for (const [rel, body] of Object.entries(all)) {
    const p = join(appRoot, rel)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, body, "utf8")
  }
  return appRoot
}

function routeArgs(appRoot: string) {
  return {
    appRoot,
    checkpointer: false as const,
    routeFile: join(appRoot, "src/app/park/index.ts"),
    routeId: "/park",
    routePath: "src/app/park/index.ts",
  }
}

describe("client tools — route preparation", () => {
  it("injects a client_<name> stub per client definition and bypasses the graph cache", async () => {
    const appRoot = await fixtureApp({ "src/app/park/index.ts": AGENT_ROUTE })
    const prepared = await prepareRouteExecution({
      ...routeArgs(appRoot),
      clientTools: [OPEN_PANEL],
    })
    if (!prepared.ok) throw new Error(prepared.message)
    const stub = prepared.tools.find((t) => t.name === "client_openPanel")
    expect(stub).toBeDefined()
    expect(stub?.filePath).toBe("<client:openPanel>")
    expect(stub?.scope).toBe("route-local")
    expect(stub?.schema).toEqual(OPEN_PANEL.parameters)
    expect(prepared.bypassCache).toBe(true)
  })

  it("without client tools, injects no stub and leaves the cache in play", async () => {
    const appRoot = await fixtureApp({ "src/app/park/index.ts": AGENT_ROUTE })
    const prepared = await prepareRouteExecution(routeArgs(appRoot))
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.tools.some((t) => t.name.startsWith("client_"))).toBe(false)
    expect(prepared.bypassCache).toBeUndefined()
  })

  it("an empty client tool list is the same as none", async () => {
    const appRoot = await fixtureApp({ "src/app/park/index.ts": AGENT_ROUTE })
    const prepared = await prepareRouteExecution({ ...routeArgs(appRoot), clientTools: [] })
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.tools.some((t) => t.name.startsWith("client_"))).toBe(false)
    expect(prepared.bypassCache).toBeUndefined()
  })

  it("refuses an authored tool whose name takes the reserved client_ prefix", async () => {
    const appRoot = await fixtureApp({
      "src/app/park/index.ts": AGENT_ROUTE,
      "src/app/park/tools/client_x.ts": 'export default async () => "ok"\n',
    })
    const prepared = await prepareRouteExecution(routeArgs(appRoot))
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.message).toContain(
      'Reserved tool name prefix: "client_" is reserved for client-provided tools (tool "client_x").',
    )
  })

  it("refuses client tools on a non-agent route", async () => {
    const appRoot = await fixtureApp({
      "src/app/park/index.ts": "export const graph = async () => ({ ok: true })\n",
    })
    const prepared = await prepareRouteExecution({
      ...routeArgs(appRoot),
      clientTools: [OPEN_PANEL],
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.message).toBe(
      'Route "/park" is a graph route; client-provided tools can only be added to an agent route.',
    )
  })

  it("never shares a compiled graph between runs with and without client tools", async () => {
    // Tools are not part of the materialized-agent cache key; only
    // `bypassCache` keeps one request's client tools out of the next's graph.
    const appRoot = await fixtureApp({ "src/app/park/index.ts": AGENT_ROUTE })
    const checkpointer = new MemorySaver()
    const base = {
      appRoot,
      checkpointer,
      routeFile: join(appRoot, "src/app/park/index.ts"),
      routeId: "/park",
      routePath: "src/app/park/index.ts",
    }
    const withClient = await materializeResolvedRouteGraph({ ...base, clientTools: [OPEN_PANEL] })
    const plainA = await materializeResolvedRouteGraph(base)
    const plainB = await materializeResolvedRouteGraph(base)
    const withClientAgain = await materializeResolvedRouteGraph({
      ...base,
      clientTools: [OPEN_PANEL],
    })

    expect(toolNamesOf(withClient)).toContain("client_openPanel")
    expect(toolNamesOf(plainA)).not.toContain("client_openPanel")
    // The plain graph is cached; the client-tool graphs never are.
    expect(plainB).toBe(plainA)
    expect(withClientAgain).not.toBe(withClient)
    expect(withClientAgain).not.toBe(plainA)
    expect(toolNamesOf(withClientAgain)).toContain("client_openPanel")
  }, 30_000)
})

/** Tool names bound into a materialized createAgent graph. */
function toolNamesOf(graph: unknown): string[] {
  const tools = (graph as { options?: { tools?: unknown } }).options?.tools
  if (!Array.isArray(tools)) throw new Error("materialized agent exposes no tools")
  return tools.map((t) => (t as { name: string }).name)
}
