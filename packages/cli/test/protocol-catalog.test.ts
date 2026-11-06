import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { B4Config, RouteManifest } from "@b4run/core"
import { agent } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph-checkpoint"
import { Ajv2020 } from "ajv/dist/2020.js"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { afterEach, describe, expect, it } from "vitest"
import { runBuildCommand } from "../src/commands/build.ts"
import { runCheckCommand } from "../src/commands/check.ts"
import { createAgentCatalog, type ResolvedAgentSchema } from "../src/lib/dev/protocol/catalog.ts"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.ts"
import { createRuntimeRegistryFromManifest } from "../src/lib/dev/runtime-registry-core.ts"
import { nodeBootFallbacks } from "../src/lib/runtime/execute-route.ts"
import {
  __resetPreparedRouteModulesForTests,
  seedPreparedRouteModules,
} from "../src/lib/runtime/execute-route-core.ts"
import { checkAgentProtocolDefault } from "../src/lib/verify/check-runtime.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __resetPreparedRouteModulesForTests()
})

const limits = { requestBytes: 1048576, pendingPrompts: 64 }
function required<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error("Required fixture value is absent")
  return value
}
function catalogRegistry(
  kinds: readonly ("agent" | "chain" | "graph" | "workflow")[] = [
    "agent",
    "chain",
    "graph",
    "workflow",
  ],
) {
  const appRoot = "/catalog"
  return createRuntimeRegistryFromManifest({
    appRoot,
    routes: kinds.map((kind) => ({
      id: `/${kind}`,
      pathname: `/${kind}`,
      kind,
      routeDir: `${appRoot}/src/app/${kind}`,
      entryFile: `${appRoot}/src/app/${kind}/index.ts`,
      segments: [],
    })),
  })
}
function catalogOptions(registry = catalogRegistry()) {
  const loaded: string[] = []
  const boot = {
    bootFallbacks: {
      ...nodeBootFallbacks,
      loadRouteModules: async (route: { routeId: string }) => {
        loaded.push(route.routeId)
        return {
          module: {
            kind: required(registry.entries.find((entry) => entry.routeId === route.routeId)).mode,
            entry: {},
            config: {},
          },
          tools: [],
          stateFields: undefined,
          memory: null,
        }
      },
    },
  }
  return {
    appRoot: registry.appRoot,
    registry,
    request: new Request("http://catalog/agents/search"),
    middleware: undefined,
    boot,
    limits,
    loaded,
  }
}

describe("standard Agent catalog", () => {
  it("describes every runnable kind using exact canonical IDs without executing entries", async () => {
    const options = catalogOptions()
    const catalog = await createAgentCatalog(options)
    const agents = await catalog.list()
    expect(agents.map((item) => item.agent_id)).toEqual([
      "/agent#agent",
      "/chain#chain",
      "/graph#graph",
      "/workflow#workflow",
    ])
    expect(agents.map((item) => item.metadata.b4.kind)).toEqual([
      "agent",
      "chain",
      "graph",
      "workflow",
    ])
    expect(agents.every((item) => !item.metadata.b4.isDefault)).toBe(true)
    expect(options.loaded.sort()).toEqual(["/agent", "/chain", "/graph", "/workflow"])
    const schema = JSON.parse(
      readFileSync(new URL("../../sdk/dist/agent-protocol.schema.json", import.meta.url), "utf8"),
    )
    const ajv = new Ajv2020({ strict: false, formats: fullFormats })
    ajv.addSchema({ ...schema, $id: "urn:b4:cli:catalog" })
    const validate = ajv.compile({ $ref: "urn:b4:cli:catalog#/$defs/B4Agent" })
    for (const item of agents) expect(validate(item), JSON.stringify(validate.errors)).toBe(true)
  })
  it("keeps explicit-ID selection usable with multiple routes and returns agent_required only for omission", async () => {
    const catalog = await createAgentCatalog(catalogOptions())
    expect(catalog.select("/chain#chain").routeId).toBe("/chain")
    expect(() => catalog.select()).toThrow(
      expect.objectContaining({ code: "agent_required", status: 422 }),
    )
    expect(() => catalog.select("/chain")).toThrow(expect.objectContaining({ code: "not_found" }))
  })
  it("selects a sole public runnable automatically", async () => {
    const catalog = await createAgentCatalog(catalogOptions(catalogRegistry(["workflow"])))
    expect(catalog.select().assistantId).toBe("/workflow#workflow")
    expect((await catalog.list())[0]?.metadata.b4.isDefault).toBe(true)
  })
  it("honors an explicit exact default with multiple routes", async () => {
    const catalog = await createAgentCatalog({
      ...catalogOptions(),
      config: { server: { agentProtocol: { defaultAgentId: "/graph#graph" } } },
    })
    expect(catalog.select().assistantId).toBe("/graph#graph")
    expect((await catalog.get("/graph#graph")).metadata.b4.isDefault).toBe(true)
  })
  it("authorizes all identities before importing descriptions or applying pagination", async () => {
    const options = catalogOptions()
    const authorized: string[] = []
    const catalog = await createAgentCatalog({
      ...options,
      middleware: async (request) => {
        expect(options.loaded).toEqual([])
        authorized.push(request.assistantId)
        return request.routeId === "/chain"
          ? { action: "reject", status: 403, body: "private" }
          : { action: "continue" }
      },
    })
    expect(authorized).toEqual([
      "/agent#agent",
      "/chain#chain",
      "/graph#graph",
      "/workflow#workflow",
    ])
    expect((await catalog.list({ offset: 1, limit: 1 })).map((item) => item.agent_id)).toEqual([
      "/graph#graph",
    ])
    expect(options.loaded).toEqual(["/graph"])
    await expect(catalog.get("/chain#chain")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    expect(options.loaded).not.toContain("/chain")
  })
  it("never substitutes an authorized route for a configured denied default", async () => {
    const options = catalogOptions()
    const catalog = await createAgentCatalog({
      ...options,
      config: { server: { agentProtocol: { defaultAgentId: "/agent#agent" } } },
      middleware: async (request) =>
        request.routeId === "/agent"
          ? { action: "reject", status: 403, body: "denied" }
          : { action: "continue" },
    })
    expect(() => catalog.select()).toThrow(expect.objectContaining({ code: "not_found" }))
    expect(catalog.select("/chain#chain").routeId).toBe("/chain")
    expect(options.loaded).toEqual([])
  })
  it("filters private static route paths before authorization or imports", async () => {
    const options = catalogOptions(catalogRegistry(["workflow"]))
    const hidden = {
      ...required(options.registry.entries[0]),
      routePath: "src/app/_internal/index.ts",
    }
    let authorized = false
    const registry = { ...options.registry, entries: [hidden] }
    const catalog = await createAgentCatalog({
      ...options,
      registry,
      middleware: async () => {
        authorized = true
        return { action: "continue" }
      },
    })
    expect(await catalog.list()).toEqual([])
    expect(authorized).toBe(false)
    expect(options.loaded).toEqual([])
  })
  it("propagates a protected-route import failure only after authorization", async () => {
    const options = catalogOptions(catalogRegistry(["workflow"]))
    const catalog = await createAgentCatalog({
      ...options,
      boot: {
        bootFallbacks: {
          ...options.boot.bootFallbacks,
          loadRouteModules: async () => {
            throw new Error("real import failed")
          },
        },
      },
    })
    await expect(catalog.get("/workflow#workflow")).rejects.toThrow("real import failed")
  })
  it("publishes actual input/output/state/config schemas and leaves opaque raw graph schemas open", async () => {
    const options = catalogOptions(catalogRegistry(["graph", "workflow"]))
    const schemas: ResolvedAgentSchema = {
      input_schema: { type: "string" },
      output_schema: { type: "number" },
      state_schema: { type: "object", properties: { count: { type: "number" } } },
      config_schema: { type: "object", properties: { locale: { type: "string" } } },
    }
    const catalog = await createAgentCatalog({
      ...options,
      routeSchemas: new Map([["/workflow#workflow", schemas]]),
    })
    expect(await catalog.schema("/workflow#workflow")).toEqual({
      ...schemas,
      agent_id: "/workflow#workflow",
    })
    expect(await catalog.schema("/graph#graph")).toEqual({
      agent_id: "/graph#graph",
      input_schema: {},
      output_schema: {},
    })
    expect((await catalog.get("/graph#graph")).capabilities["ap.io.messages"]).toBeUndefined()
  })
  it("keeps schema resource identity canonical even when adapter documents carry an identity", async () => {
    const docs = { agent_id: "/foreign#graph", input_schema: { type: "string" }, output_schema: {} }
    const catalog = await createAgentCatalog({
      ...catalogOptions(catalogRegistry(["graph"])),
      routeSchemas: new Map([["/graph#graph", docs]]),
    })
    expect((await catalog.schema("/graph#graph")).agent_id).toBe("/graph#graph")
  })
  it("rejects a stale manifest kind rather than describing an incompatible loaded route", async () => {
    const options = catalogOptions(catalogRegistry(["workflow"]))
    const catalog = await createAgentCatalog({
      ...options,
      boot: {
        bootFallbacks: {
          ...options.boot.bootFallbacks,
          loadRouteModules: async () => ({
            module: { kind: "graph" as const, entry: {}, config: {} },
            tools: [],
            stateFields: undefined,
            memory: null,
          }),
        },
      },
    })
    await expect(catalog.get("/workflow#workflow")).rejects.toThrow(/kind/)
  })
  it("does not infer protocol services or standard messages/streaming from configured flags or runnable kind", async () => {
    const catalog = await createAgentCatalog({
      ...catalogOptions(),
      config: {
        server: {
          agentProtocol: { defaultAgentId: "/agent#agent", backgroundRuns: true },
          agui: { clientTools: ["/agent"] },
        },
      } as B4Config,
    })
    for (const item of await catalog.list()) {
      expect(Object.keys(item.capabilities)).toEqual(["run.b4.agui"])
      expect(item.metadata.b4.schemas).toEqual({})
      expect(item.metadata.b4.limits).toEqual(limits)
    }
  })
  it("reuses native capabilities with unknown sections and nested fields omitted", async () => {
    const catalog = await createAgentCatalog(catalogOptions(catalogRegistry(["agent"])))
    const native = required((await catalog.get("/agent#agent")).capabilities["run.b4.agui"])
    expect(native.path).toBe("/agui/%2Fagent%23agent")
    expect(native.capabilities.transport).toEqual({ streaming: true, httpBinary: true })
    expect(native.capabilities.state).toEqual({ snapshots: false, deltas: false })
    expect(native.capabilities.multimodal).toBeUndefined()
    expect(native.capabilities.execution).toBeUndefined()
    expect(native.capabilities.tools?.parallelCalls).toBeUndefined()
    expect(native.capabilities.humanInTheLoop?.approvals).toBeUndefined()
  })
  it("does not claim descriptor persistence or parking without a resolved checkpointer", async () => {
    const options = catalogOptions(catalogRegistry(["agent"]))
    seedPreparedRouteModules(
      new Map([
        [
          required(options.registry.entries[0]).routeFile,
          {
            module: {
              kind: "agent",
              entry: agent({ model: "gpt-5-mini", systemPrompt: "unused" }),
              config: {},
            },
            tools: [],
            stateFields: undefined,
            memory: null,
          },
        ],
      ]),
    )
    const catalog = await createAgentCatalog(options)
    const native = required(
      (await catalog.get("/agent#agent")).capabilities["run.b4.agui"],
    ).capabilities
    expect(native.state?.persistentState).toBeUndefined()
    expect(native.humanInTheLoop?.interrupts).toBeUndefined()
    expect(native.humanInTheLoop?.approvals).toBeUndefined()
    const persistentCatalog = await createAgentCatalog({
      ...options,
      resolved: { checkpointer: new MemorySaver() },
    })
    const persistent = required(
      (await persistentCatalog.get("/agent#agent")).capabilities["run.b4.agui"],
    ).capabilities
    expect(persistent.state?.persistentState).toBe(true)
    expect(persistent.humanInTheLoop?.interrupts).toBe(true)
  })
  it("never rediscovers protected routes when a hand-built registry omits its manifest", async () => {
    const options = catalogOptions(catalogRegistry(["agent"]))
    const { manifest: _manifest, ...registry } = options.registry
    const route = required(registry.entries[0])
    seedPreparedRouteModules(
      new Map([
        [
          route.routeFile,
          {
            module: {
              kind: "agent",
              entry: agent({ model: "gpt-5-mini", systemPrompt: "unused" }),
              config: {},
            },
            tools: [],
            stateFields: undefined,
            memory: null,
          },
        ],
      ]),
    )
    let rediscovered = false
    const catalog = await createAgentCatalog({
      ...options,
      registry,
      boot: {
        bootFallbacks: {
          ...options.boot.bootFallbacks,
          discoverRouteManifest: async () => {
            rediscovered = true
            throw new Error("protected discovery")
          },
        },
      },
    })
    await catalog.get("/agent#agent")
    expect(rediscovered).toBe(false)
  })
  it("retains authorized parent subagent metadata without importing a denied sibling", async () => {
    const appRoot = await fixture("{}")
    for (const [path, source] of Object.entries({
      "src/app/parent/index.ts":
        'import { agent } from "@b4run/sdk"; export default agent({ model: "gpt-5-mini", description: "Parent", systemPrompt: "unused" })',
      "src/app/parent/subagents/helper/index.ts":
        'import { agent } from "@b4run/sdk"; export default agent({ model: "gpt-5-mini", description: "Safe helper", systemPrompt: "unused" })',
      "src/app/denied/index.ts":
        'throw new Error("DENIED SIBLING IMPORTED"); export const agent = {}',
    })) {
      await mkdir(dirname(join(appRoot, path)), { recursive: true })
      await writeFile(join(appRoot, path), source)
    }
    const manifest: RouteManifest = {
      appRoot,
      routes: ["/parent", "/parent/subagents/helper", "/denied"].map((id) => ({
        id,
        pathname: id,
        kind: "agent",
        routeDir: `${appRoot}/src/app${id}`,
        entryFile: `${appRoot}/src/app${id}/index.ts`,
        segments: [],
      })),
    }
    const options = {
      appRoot,
      registry: createRuntimeRegistryFromManifest(manifest),
      request: new Request("http://catalog/agents/search"),
      boot: { bootFallbacks: nodeBootFallbacks },
      limits,
      middleware: async (request: { routeId: string }) =>
        request.routeId === "/denied"
          ? { action: "reject" as const, status: 403, body: "denied" }
          : { action: "continue" as const },
    }
    const catalog = await createAgentCatalog(options)
    const parent = await catalog.get("/parent#agent")
    expect(parent.description).toBe("Parent")
    expect(required(parent.capabilities["run.b4.agui"]).capabilities.multiAgent).toEqual({
      delegation: true,
      handoffs: false,
      supported: true,
      subagents: [{ name: "helper", description: "Safe helper" }],
    })
    await expect(catalog.schema("/denied#agent")).rejects.toMatchObject({ code: "not_found" })
    const deniedHelperCatalog = await createAgentCatalog({
      ...options,
      middleware: async (request: { routeId: string }) =>
        request.routeId === "/parent"
          ? { action: "continue" as const }
          : { action: "reject" as const, status: 403, body: "denied" },
    })
    expect(
      required((await deniedHelperCatalog.get("/parent#agent")).capabilities["run.b4.agui"])
        .capabilities.multiAgent,
    ).toBeUndefined()
    const allAuthorized = await createAgentCatalog({ ...options, middleware: undefined })
    expect(
      required((await allAuthorized.get("/parent#agent")).capabilities["run.b4.agui"]).capabilities
        .multiAgent?.supported,
    ).toBe(true)
    await expect(allAuthorized.get("/denied#agent")).rejects.toThrow("DENIED SIBLING IMPORTED")
  })
  it("publishes complete effective limit groups and rejects unknown required ceilings", async () => {
    const options = catalogOptions(catalogRegistry(["workflow"]))
    const effective = {
      ...limits,
      eventBytes: 400,
      snapshotBytes: 500,
      inbox: { entries: 2, bytes: 300, textBytes: 20 },
      viewer: { events: 3, bytes: 400 },
      inspection: {
        requestBytes: 100,
        responseBytes: 200,
        defaults: { maxEntries: 2, maxFileBytes: 3, maxTotalBytes: 4 },
        caps: { maxEntries: 20, maxFileBytes: 30, maxTotalBytes: 40 },
      },
      staging: { uploadBytes: 200, quotaBytes: 800, deadlineMs: 300 },
    }
    const catalog = await createAgentCatalog({ ...options, limits: effective })
    expect((await catalog.list())[0]?.metadata.b4.limits).toEqual(effective)
    await expect(
      createAgentCatalog({ ...options, limits: { requestBytes: 10 } as typeof limits }),
    ).rejects.toThrow(/pendingPrompts/)
    await expect(
      createAgentCatalog({
        ...options,
        limits: { ...limits, staging: { uploadBytes: 2 } } as unknown as typeof effective,
      }),
    ).rejects.toThrow(/quotaBytes/)
  })
})
const io = { stdout: (_text: string) => {}, stderr: (_text: string) => {} }
async function fixture(config: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-protocol-catalog-"))
  cleanup.push(() => rm(appRoot, { recursive: true, force: true }))
  for (const [path, source] of Object.entries({
    "package.json": '{"type":"module"}',
    "b4.config.ts": `export default ${config}`,
    "src/app/only/index.ts": "export const workflow = async (input) => input",
  })) {
    const file = join(appRoot, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, source)
  }
  return appRoot
}

describe("Agent catalog default integration", () => {
  it("check, build and boot accept a valid exact configured default", async () => {
    const appRoot = await fixture(
      '{ build: { targets: [] }, server: { agentProtocol: { defaultAgentId: "/only#workflow" } } }',
    )
    await runCheckCommand({ cwd: appRoot }, io)
    await runBuildCommand({ cwd: appRoot }, io)
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())
  })
  it("check rejects a configured default absent from public runnable routes", async () => {
    const appRoot = await fixture(
      '{ server: { agentProtocol: { defaultAgentId: "/missing#workflow" } } }',
    )
    await expect(runCheckCommand({ cwd: appRoot }, io)).rejects.toThrow(/defaultAgentId/)
  })
  it("build rejects a configured default before emitting artifacts", async () => {
    const appRoot = await fixture(
      '{ build: { targets: [] }, server: { agentProtocol: { defaultAgentId: "/only" } } }',
    )
    await expect(runBuildCommand({ cwd: appRoot }, io)).rejects.toThrow(/defaultAgentId/)
  })
  it("boot rejects a configured default without silently selecting the sole route", async () => {
    const appRoot = await fixture(
      '{ server: { agentProtocol: { defaultAgentId: "/missing#workflow" } } }',
    )
    const boot = createRuntimeFetchHandler({ appRoot }).then((handler) => {
      cleanup.push(() => handler.close())
      return handler
    })
    await expect(boot).rejects.toThrow(/defaultAgentId/)
  })
})

describe("Agent catalog route identity", () => {
  it("rejects private configured defaults even in a static manifest", () => {
    const routes = [
      {
        assistantId: "/hidden#graph",
        mode: "graph" as const,
        routeId: "/hidden",
        routePath: "src/app/_private/hidden/index.ts",
        routeFile: "/app/hidden.ts",
      },
    ]
    expect(() =>
      checkAgentProtocolDefault(
        { server: { agentProtocol: { defaultAgentId: "/hidden#graph" } } },
        routes,
      ),
    ).toThrow(/defaultAgentId/)
  })
  it.each(["", " /only#workflow", 4, null, []])("rejects malformed default ID %j", (id) => {
    expect(() =>
      checkAgentProtocolDefault(
        { server: { agentProtocol: { defaultAgentId: id } } } as unknown as B4Config,
        [],
      ),
    ).toThrow(/defaultAgentId/)
  })
  it("does not fabricate an Agent when the selected route's real import fails", async () => {
    const appRoot = await fixture("{}")
    const manifest: RouteManifest = {
      appRoot,
      routes: [
        {
          id: "/broken",
          kind: "agent",
          pathname: "/broken",
          routeDir: appRoot,
          entryFile: join(appRoot, "broken.ts"),
          segments: [],
        },
      ],
    }
    await writeFile(
      join(appRoot, "broken.ts"),
      'throw new Error("catalog import failed"); export const agent = {}',
    )
    const catalog = await createAgentCatalog({
      appRoot,
      registry: createRuntimeRegistryFromManifest(manifest),
      request: new Request("http://catalog/agents/search"),
      middleware: undefined,
      boot: { bootFallbacks: nodeBootFallbacks },
      limits,
    })
    await expect(catalog.get("/broken#agent")).rejects.toThrow("catalog import failed")
  })
})
