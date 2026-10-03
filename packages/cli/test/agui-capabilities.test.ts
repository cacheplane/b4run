import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas"
import { toLangChainContent } from "@b4run/langchain"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { handleAgUiCapabilitiesRequest } from "../src/lib/dev/agui-capabilities.ts"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.ts"
import { nodeBootFallbacks } from "../src/lib/runtime/execute-route.ts"
import { checkRouteModalitySupport } from "../src/lib/runtime/execute-route-core.ts"

/**
 * `GET /agui/:routeId` advertises a route's AG-UI capabilities. The claims are
 * derived from the code `POST` enforces with, so the last block checks them
 * against `POST` itself rather than against a restated expectation.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const DESCRIPTOR_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", systemPrompt: "t" })',
  "",
].join("\n")

/** A provider that cannot bind a JSON schema alongside tool calls. */
const GEMINI_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gemini-2.5-flash", systemPrompt: "t" })',
  "",
].join("\n")

/** An agent route that asks OpenAI to stream a reasoning summary. */
const REASONING_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", reasoning: { openai: { effort: "low", summary: "auto" } }, systemPrompt: "t" })',
  "",
].join("\n")

/** Effort alone reasons but streams nothing. */
const EFFORT_ONLY_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", reasoning: { openai: { effort: "low" } }, systemPrompt: "t" })',
  "",
].join("\n")

const GRAPH_ROUTE = "export const graph = async () => ({ ok: true })\n"

/** An agent route that exports a runnable rather than an `agent()` descriptor. */
const RUNNABLE_ROUTE = "export const agent = { invoke: async () => ({ messages: [] }) }\n"

const MIDDLEWARE = `
  export default (request) => request.headers["x-api-key"] === "secret"
    ? { action: "continue" }
    : { action: "reject", status: 401, body: { error: "missing api key" } }
`

/** Claims every route makes, whatever its module says. */
const TRANSPORT = { httpBinary: true, streaming: true }
const NO_REASONING = { supported: false }
const AGENT_STATE = { deltas: false, persistentState: true, snapshots: false }
const RAW_STATE = { deltas: false, snapshots: false }
const ONE_SHOT_STATE = { deltas: false, persistentState: false, snapshots: false }
/** gpt-5-mini's profile: images and PDFs, no audio or video. */
const GPT_5_MINI_MULTIMODAL = {
  input: { audio: false, file: false, image: true, pdf: true, video: false },
  output: { audio: false, image: false },
}

async function fixtureApp(
  options: { config?: string; files?: Record<string, string> } = {},
): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-capabilities-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts":
      options.config ??
      'export default { server: { agui: { clientTools: ["/open", "/echo"] } } }\n',
    "package.json": '{ "name": "agui-capabilities-fixture", "type": "module" }\n',
    "src/app/open/index.ts": DESCRIPTOR_ROUTE,
    "src/app/closed/index.ts": DESCRIPTOR_ROUTE,
    "src/app/echo/index.ts": GRAPH_ROUTE,
    "src/app/gemini/index.ts": GEMINI_ROUTE,
    "src/app/raw/index.ts": RUNNABLE_ROUTE,
    "src/app/thinking/index.ts": REASONING_ROUTE,
    "src/app/effort/index.ts": EFFORT_ONLY_ROUTE,
    ...options.files,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

type HandlerOptions = Parameters<typeof createRuntimeFetchHandler>[0]

/** The node fallbacks with the named boot stores resolving to nothing. */
const WITHOUT_CLIENT_TOOL_STORE: HandlerOptions["bootFallbacks"] = {
  ...nodeBootFallbacks,
  resolveClientToolCallStore: async () => undefined,
}
const WITHOUT_GRANT_STORE: HandlerOptions["bootFallbacks"] = {
  ...nodeBootFallbacks,
  resolveInterruptGrantStore: async () => undefined,
}

async function createHandler(appRoot: string, bootFallbacks?: HandlerOptions["bootFallbacks"]) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
    ...(bootFallbacks ? { bootFallbacks } : {}),
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

function capabilitiesUrl(routeKey: string): string {
  return `http://localhost/agui/${encodeURIComponent(routeKey)}`
}

async function capabilities(handler: Handler, routeKey: string, headers?: Record<string, string>) {
  const response = await handler.fetch(
    new Request(capabilitiesUrl(routeKey), { headers: headers ?? {}, method: "GET" }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body: unknown = await response.json()
  // Whatever B4.run says must be a document AG-UI clients can parse — and
  // parsing must not have dropped anything B4.run meant to say.
  expect(AgentCapabilitiesSchema.parse(body)).toEqual(body)
  return body as Record<string, Record<string, unknown>>
}

describe("GET /agui/:routeId", () => {
  it("advertises an opted-in agent() route's client tools, structured output and approvals", async () => {
    const handler = await createHandler(await fixtureApp())

    expect(await capabilities(handler, "/open#agent")).toEqual({
      humanInTheLoop: {
        approvals: true,
        approveWithEdits: false,
        interrupts: true,
        supported: true,
      },
      multimodal: GPT_5_MINI_MULTIMODAL,
      output: { structuredOutput: true },
      reasoning: NO_REASONING,
      state: AGENT_STATE,
      tools: { clientProvided: true, parallelCalls: true, supported: true },
      transport: TRANSPORT,
    })
  })

  it("advertises reasoning only when the route's config makes it stream", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/thinking#agent")).reasoning).toEqual({
      encrypted: false,
      streaming: true,
      supported: true,
    })
    expect((await capabilities(handler, "/effort#agent")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/open#agent")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/echo#graph")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/raw#agent")).reasoning).toEqual(NO_REASONING)
  })

  it("advertises multimodal input from the model profile on an agent route", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/open#agent")).multimodal).toEqual(GPT_5_MINI_MULTIMODAL)
    expect((await capabilities(handler, "/closed#agent")).multimodal).toEqual(GPT_5_MINI_MULTIMODAL)
    // gemini-2.5-flash: image, audio, video and PDF all true in its profile.
    expect((await capabilities(handler, "/gemini#agent")).multimodal).toEqual({
      input: { audio: true, file: false, image: true, pdf: true, video: true },
      output: { audio: false, image: false },
    })
  })

  it("omits multimodal for a raw runnable and a non-agent route", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/raw#agent")).multimodal).toBeUndefined()
    expect((await capabilities(handler, "/echo#graph")).multimodal).toBeUndefined()
  })

  it("does not advertise client tools on an agent() route that did not opt in", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/closed#agent")).tools).toEqual({
      clientProvided: false,
      parallelCalls: true,
      supported: true,
    })
  })

  it("does not advertise structured output when the route's provider cannot bind a schema", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/gemini#agent")).output).toEqual({
      structuredOutput: false,
    })
  })

  it("advertises nothing a graph route cannot do, even when config names it", async () => {
    const handler = await createHandler(await fixtureApp())

    expect(await capabilities(handler, "/echo#graph")).toEqual({
      humanInTheLoop: {
        approvals: false,
        approveWithEdits: false,
        interrupts: false,
        supported: false,
      },
      output: { structuredOutput: false },
      reasoning: NO_REASONING,
      state: ONE_SHOT_STATE,
      tools: { clientProvided: false, supported: false },
      transport: TRANSPORT,
    })
  })

  it("leaves out what a raw agent runnable's own code decides", async () => {
    const handler = await createHandler(
      await fixtureApp({
        config: 'export default { server: { agui: { clientTools: ["/raw"] } } }\n',
      }),
    )

    expect(await capabilities(handler, "/raw#agent")).toEqual({
      humanInTheLoop: { approveWithEdits: false, interrupts: true, supported: true },
      output: { structuredOutput: false },
      reasoning: NO_REASONING,
      state: RAW_STATE,
      tools: { clientProvided: false },
      transport: TRANSPORT,
    })
  })

  it.each([
    ["non-interactive", false],
    ["bypass", false],
    ["interactive", true],
  ] as const)("advertises approvals from the permissions mode (%s)", async (mode, approvals) => {
    const handler = await createHandler(
      await fixtureApp({ config: `export default { permissions: { mode: "${mode}" } }\n` }),
    )

    expect((await capabilities(handler, "/closed#agent")).humanInTheLoop).toMatchObject({
      approvals,
    })
  })

  it("does not advertise client tools when no client tool store resolved", async () => {
    const handler = await createHandler(await fixtureApp(), WITHOUT_CLIENT_TOOL_STORE)

    expect((await capabilities(handler, "/open#agent")).tools).toMatchObject({
      clientProvided: false,
    })
  })

  it.each([
    ["required", WITHOUT_GRANT_STORE, false],
    ["optional", WITHOUT_GRANT_STORE, true],
    ["required", undefined, true],
  ] as const)(
    "advertises approvals only when they can be answered (grants %s, store %#)",
    async (grants, bootFallbacks, approvals) => {
      const handler = await createHandler(
        await fixtureApp({ config: `export default { approvals: { grants: "${grants}" } }\n` }),
        bootFallbacks,
      )

      expect((await capabilities(handler, "/closed#agent")).humanInTheLoop).toMatchObject({
        approvals,
      })
    },
  )

  it("surfaces a route module that fails to load instead of describing it", async () => {
    const handler = await createHandler(
      await fixtureApp({
        files: {
          "src/app/broken/index.ts": DESCRIPTOR_ROUTE,
          "src/app/broken/tools/explode.ts": 'throw new Error("boom")\n',
        },
      }),
    )

    const response = await handler.fetch(new Request(capabilitiesUrl("/broken#agent")))

    expect(response.status).toBe(500)
  })

  it("claims only what needs no route module on a boot that cannot load them", async () => {
    // No node fallbacks and no static manifest seeding the module cache — the
    // preflight `POST` would run cannot run here either.
    const routeFile = join(tmpdir(), `b4-unloadable-${Date.now()}`, "index.ts")
    const response = await handleAgUiCapabilitiesRequest({
      appRoot: dirname(routeFile),
      middleware: undefined,
      registry: {
        appRoot: dirname(routeFile),
        entries: [],
        lookup: () => ({
          assistantId: "/x#agent",
          mode: "agent",
          routeFile,
          routeId: "/x",
          routePath: "index.ts",
        }),
      },
      request: new Request(capabilitiesUrl("/x#agent")),
      routeKey: "/x#agent",
    })

    expect(response.status).toBe(200)
    // reasoning is a fact about the translator; persistentState needs the
    // module, so it is omitted.
    expect(await response.json()).toEqual({
      reasoning: NO_REASONING,
      state: RAW_STATE,
      transport: TRANSPORT,
    })
  })

  it("omits multimodal, and keeps the rest, when the provider package cannot be read", async () => {
    const appRoot = await fixtureApp()
    const routeFile = join(appRoot, "src/app/open/index.ts")
    const brokenInstall = async (): Promise<Record<string, unknown>> => {
      throw new Error("SyntaxError in @langchain/openai")
    }

    const support = await checkRouteModalitySupport({
      appRoot,
      bootFallbacks: nodeBootFallbacks,
      importer: brokenInstall,
      routeFile,
      routeId: "/open",
    })
    expect(support).toEqual({ ok: false, message: "SyntaxError in @langchain/openai" })

    const response = await handleAgUiCapabilitiesRequest({
      appRoot,
      boot: { bootFallbacks: nodeBootFallbacks },
      middleware: undefined,
      modelImporter: brokenInstall,
      registry: {
        appRoot,
        entries: [],
        lookup: () => ({
          assistantId: "/open#agent",
          mode: "agent",
          routeFile,
          routeId: "/open",
          routePath: "open/index.ts",
        }),
      },
      request: new Request(capabilitiesUrl("/open#agent")),
      routeKey: "/open#agent",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      humanInTheLoop: {
        approvals: false,
        approveWithEdits: false,
        interrupts: true,
        supported: true,
      },
      output: { structuredOutput: true },
      reasoning: NO_REASONING,
      state: AGENT_STATE,
      tools: { clientProvided: false, parallelCalls: true, supported: true },
      transport: TRANSPORT,
    })
  })

  it("names a provider package that does not export its chat model", async () => {
    const appRoot = await fixtureApp()
    expect(
      await checkRouteModalitySupport({
        appRoot,
        bootFallbacks: nodeBootFallbacks,
        importer: async () => ({}),
        routeFile: join(appRoot, "src/app/open/index.ts"),
        routeId: "/open",
      }),
    ).toEqual({
      ok: false,
      message: 'Provider package for "openai" is not installed or does not export its chat model',
    })
  })

  it("advertises the binary binding on a one-shot route", async () => {
    const handler = await createHandler(await fixtureApp())
    expect((await capabilities(handler, "/echo#graph")).transport).toEqual(TRANSPORT)
  })

  it("is 404 for an unknown route", async () => {
    const handler = await createHandler(await fixtureApp())

    const response = await handler.fetch(new Request(capabilitiesUrl("/nope#agent")))

    expect(response.status).toBe(404)
  })

  it("runs route middleware before disclosing anything", async () => {
    const handler = await createHandler(
      await fixtureApp({ files: { "src/middleware.ts": MIDDLEWARE } }),
    )

    const refused = await handler.fetch(new Request(capabilitiesUrl("/open#agent")))
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: "missing api key" })

    expect((await capabilities(handler, "/open#agent", { "x-api-key": "secret" })).tools).toEqual(
      expect.objectContaining({ clientProvided: true }),
    )
  })
})

describe("GET /agui/:routeId agrees with what POST enforces", () => {
  const ROUTES = ["/open#agent", "/closed#agent", "/gemini#agent", "/echo#graph", "/raw#agent"]

  async function withModel() {
    const aimock = await createAimock({ fixtures: [] })
    cleanup.push(() => aimock.close())
    const prevBaseUrl = process.env.OPENAI_BASE_URL
    const prevKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = prevKey ?? "test-not-used"
    cleanup.push(() => {
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    })
    aimock.addFixtures([{ match: { userMessage: "hello" }, response: { content: "{}" } }] as never)
  }

  /** The 422/503 `code` POST answers with, or undefined when it admitted the run. */
  async function postRejection(
    handler: Handler,
    routeKey: string,
    extra: Record<string, unknown>,
  ): Promise<string | undefined> {
    const response = await handler.fetch(
      new Request(capabilitiesUrl(routeKey), {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ content: "hello", id: "m1", role: "user" }],
          runId: "run-1",
          state: {},
          threadId: `t-${routeKey}-${Object.keys(extra).join()}`,
          tools: [],
          ...extra,
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      }),
    )
    if (response.status === 200) {
      await response.body?.cancel()
      return undefined
    }
    expect([422, 503]).toContain(response.status)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    return body.error.details?.code
  }

  it.each(ROUTES)("client tools and structured output on %s", async (routeKey) => {
    await withModel()
    const handler = await createHandler(await fixtureApp())
    const advertised = await capabilities(handler, routeKey)

    const tools = await postRejection(handler, routeKey, {
      tools: [{ description: "Open a panel", name: "openPanel", parameters: { type: "object" } }],
    })
    expect(tools === undefined).toBe(advertised.tools?.clientProvided)

    const schema = await postRejection(handler, routeKey, {
      hashbrown: { responseSchema: { type: "object" } },
    })
    expect(schema === undefined).toBe(advertised.output?.structuredOutput)
  })

  it.each(ROUTES)("the binding on %s", async (routeKey) => {
    await withModel()
    const handler = await createHandler(await fixtureApp())
    expect((await capabilities(handler, routeKey)).transport?.httpBinary).toBe(true)

    const response = await handler.fetch(
      new Request(capabilitiesUrl(routeKey), {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ content: "hello", id: "m1", role: "user" }],
          runId: "run-binding",
          state: {},
          threadId: `t-binding-${routeKey}`,
          tools: [],
        }),
        headers: {
          accept: "application/vnd.ag-ui.event+proto",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/vnd.ag-ui.event+proto")
    await response.body?.cancel()
  })

  it.each(["/open#agent", "/gemini#agent", "/thinking#agent"])(
    "multimodal.input on %s equals what the run carries",
    async (routeKey) => {
      await withModel()
      const appRoot = await fixtureApp()
      const handler = await createHandler(appRoot)
      const advertised = (await capabilities(handler, routeKey)).multimodal?.input

      const routeId = routeKey.slice(0, routeKey.indexOf("#"))
      const support = await checkRouteModalitySupport({
        appRoot,
        bootFallbacks: nodeBootFallbacks,
        routeFile: join(appRoot, "src/app", routeId, "index.ts"),
        routeId,
      })
      if (!support.ok) throw new Error(support.message)
      const carried = (type: "image" | "audio" | "video" | "document") =>
        toLangChainContent(
          [
            {
              source: {
                mimeType: type === "document" ? "application/pdf" : `${type}/x`,
                type: "data",
                value: "AAAA",
              },
              type,
            },
          ],
          support.support,
          undefined,
          "user",
        ).dropped.length === 0
      expect(advertised).toEqual({
        audio: carried("audio"),
        file: false,
        image: carried("image"),
        pdf: carried("document"),
        video: carried("video"),
      })
    },
  )

  it("client tools with no client tool store", async () => {
    await withModel()
    const handler = await createHandler(await fixtureApp(), WITHOUT_CLIENT_TOOL_STORE)

    expect((await capabilities(handler, "/open#agent")).tools?.clientProvided).toBe(false)
    expect(
      await postRejection(handler, "/open#agent", {
        tools: [{ description: "Open a panel", name: "openPanel", parameters: { type: "object" } }],
      }),
    ).toBe("client_tool_store_unavailable")
  })
})
