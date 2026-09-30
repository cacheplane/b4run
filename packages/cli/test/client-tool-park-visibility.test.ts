import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type B4AgentStreamChunk, toAguiEvents } from "@b4run/ag-ui"
import { afterEach, describe, expect, test } from "vitest"

import { __normalizeB4StreamForTests, __tapLiveTurnForTests } from "../src/lib/dev/agui-handler.js"
import { withoutClientToolParks } from "../src/lib/dev/pending-interrupts.js"
import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"
import type { StreamChunk } from "../src/lib/runtime/stream-types.js"

/**
 * Model A client tools: a client tool call parks server-side with LangGraph
 * `interrupt()`, but the client must see an ordinary tool call and an ordinary
 * `RUN_FINISHED` — never an interrupt outcome, never a prompt on the approval
 * surfaces — and it must see the tool under the name it registered, not the
 * `client_`-prefixed name the model sees.
 */

const clientPark = {
  type: "client-tool-call",
  interruptId: "client-call_1",
  toolCallId: "call_1",
  name: "openPanel",
  input: { panel: "settings" },
}

const permissionPark = { interruptId: "perm-1", type: "permission-request", kind: "bash" }

async function* from<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function normalize(
  chunks: readonly StreamChunk[],
  clientToolNames?: ReadonlySet<string>,
): Promise<B4AgentStreamChunk[]> {
  return collect(__normalizeB4StreamForTests(from(chunks), clientToolNames))
}

describe("normalizeB4Stream: client tool parks and names", () => {
  test("drops the client park and un-prefixes a registered client tool", async () => {
    const out = await normalize(
      [
        { type: "tool_call_args", data: { id: "call_1", name: "client_openPanel", delta: "{}" } },
        { type: "tool_call", id: "call_1", name: "client_openPanel", input: clientPark.input },
        { type: "interrupt", data: clientPark },
        { type: "done", output: null },
      ],
      new Set(["openPanel"]),
    )
    expect(out).toEqual([
      { type: "tool_call_args", data: { id: "call_1", name: "openPanel", delta: "{}" } },
      { type: "tool_call", data: { id: "call_1", name: "openPanel", input: clientPark.input } },
      { type: "done", data: null },
    ])
  })

  test("un-prefixes tool_result for a registered client tool", async () => {
    const out = await normalize(
      [{ type: "tool_result", id: "call_1", name: "client_openPanel", output: "ok" }],
      new Set(["openPanel"]),
    )
    expect(out).toEqual([
      { type: "tool_result", data: { id: "call_1", name: "openPanel", output: "ok" } },
    ])
  })

  test("a client_-prefixed name outside this run's client tools keeps its name", async () => {
    const out = await normalize(
      [
        { type: "tool_call_args", data: { id: "call_2", name: "client_other", delta: "" } },
        { type: "tool_call", id: "call_2", name: "client_other", input: {} },
        { type: "tool_result", id: "call_2", name: "client_other", output: "x" },
      ],
      new Set(["openPanel"]),
    )
    expect(out.map((chunk) => (chunk.data as { name: string }).name)).toEqual([
      "client_other",
      "client_other",
      "client_other",
    ])
  })

  test("with no client tool names (the default) nothing is renamed", async () => {
    const out = await normalize([
      { type: "tool_call", id: "call_1", name: "client_openPanel", input: {} },
    ])
    expect(out).toEqual([
      { type: "tool_call", data: { id: "call_1", name: "client_openPanel", input: {} } },
    ])
  })

  test("a permission park still passes through", async () => {
    const out = await normalize(
      [
        { type: "interrupt", data: permissionPark },
        { type: "done", output: null },
      ],
      new Set(["openPanel"]),
    )
    expect(out).toEqual([
      { type: "interrupt", data: permissionPark },
      { type: "done", data: null },
    ])
  })
})

describe("client tool park through toAguiEvents", () => {
  test("ends with an ordinary RUN_FINISHED and the client's tool name", async () => {
    const events = await collect(
      toAguiEvents(
        __normalizeB4StreamForTests(
          from<StreamChunk>([
            { type: "tool_call", id: "call_1", name: "client_openPanel", input: clientPark.input },
            { type: "interrupt", data: clientPark },
            { type: "done", output: null },
          ]),
          new Set(["openPanel"]),
        ),
        { threadId: "t-1", runId: "r-1" },
      ),
    )
    const start = events.find((event) => event.type === "TOOL_CALL_START") as
      | { toolCallName: string }
      | undefined
    expect(start?.toolCallName).toBe("openPanel")
    const last = events.at(-1) as { type: string; outcome?: unknown }
    expect(last.type).toBe("RUN_FINISHED")
    expect(last.outcome).toEqual({ type: "success" })
  })

  test("a streamed client tool call opens under the client's name too", async () => {
    const events = await collect(
      toAguiEvents(
        __normalizeB4StreamForTests(
          from<StreamChunk>([
            {
              type: "tool_call_args",
              data: { id: "call_1", name: "client_openPanel", delta: '{"panel":' },
            },
            { type: "tool_call", id: "call_1", name: "client_openPanel", input: clientPark.input },
            { type: "interrupt", data: clientPark },
            { type: "done", output: null },
          ]),
          new Set(["openPanel"]),
        ),
        { threadId: "t-1", runId: "r-1" },
      ),
    )
    const starts = events.filter((event) => event.type === "TOOL_CALL_START") as Array<{
      toolCallName: string
    }>
    expect(starts.map((start) => start.toolCallName)).toEqual(["openPanel"])
    const last = events.at(-1) as { type: string; outcome?: unknown }
    expect(last.type).toBe("RUN_FINISHED")
    expect(last.outcome).toEqual({ type: "success" })
  })
})

// ── endpoints ─────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const clientWrite = [
  "33a12321-3ec2-56a7-b4d7-0337886c4386",
  "__interrupt__",
  { id: "3336d0e0a2d4f198ef9aecd09cd7ac27", value: clientPark },
] as const

const permissionWrite = [
  "44b12321-3ec2-56a7-b4d7-0337886c4386",
  "__interrupt__",
  { id: "4446d0e0a2d4f198ef9aecd09cd7ac27", value: permissionPark },
] as const

describe("approval surfaces never show a client tool park", () => {
  test("client park only: listing is empty, attach state lists nothing, resume is refused", async () => {
    const { url } = await startFixture([clientWrite])
    const threadId = "thread-client-only"
    await seedRoute(url, threadId)

    const listing = await fetch(new URL(`/threads/${threadId}/pending_interrupts`, url))
    expect(listing.status).toBe(200)
    expect(((await listing.json()) as { interrupts: unknown[] }).interrupts).toEqual([])

    const attach = await fetch(new URL(`/threads/${threadId}/runs/stream`, url))
    expect(attach.status).toBe(200)
    const state = await readStateFrame(attach)
    expect(state.interrupts).toEqual([])

    const resume = await postResume(url, threadId, {
      resume: [{ interruptId: "client-call_1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(resume.status).toBe(409)
    expect(await codeOf(resume)).toBe("client_tool_pending")
  })

  test("permission + client park: only the permission park is listed; /resume refuses outright", async () => {
    const { url } = await startFixture([permissionWrite, clientWrite])
    const threadId = "thread-mixed"
    await seedRoute(url, threadId)

    const listing = await fetch(new URL(`/threads/${threadId}/pending_interrupts`, url))
    const body = (await listing.json()) as { interrupts: { interruptId: string }[] }
    expect(body.interrupts.map((entry) => entry.interruptId)).toEqual(["perm-1"])

    const clientAnswer = await postResume(url, threadId, {
      resume: [
        { interruptId: "perm-1", status: "resolved", payload: "once" },
        { interruptId: "client-call_1", status: "resolved", payload: "once" },
      ],
      route: "/noop#graph",
    })
    expect(clientAnswer.status).toBe(409)
    expect(await codeOf(clientAnswer)).toBe("client_tool_pending")

    // A partial resume of the permission park alone is unsafe (the answered
    // park is re-demanded, and the client task re-runs with no stubs bound),
    // so it is refused too — one clear refusal whenever a client park is
    // pending.
    const partial = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(partial.status).toBe(409)
    expect(await codeOf(partial)).toBe("client_tool_pending")
  })
})

describe("the AG-UI path never answers a client park without the retained record", () => {
  // Neither fixture opts a route in to client tools, so no client tool store
  // is resolved: a pending client park then fails closed with a 503 — never a
  // run past it, never a `resume_required` that would invite a partial,
  // permission-only resume. (With a store, matching is covered end to end in
  // agui-client-tools.test.ts.)
  test("client park only: refused with 503 client_tool_store_unavailable", async () => {
    const { url } = await startFixture([clientWrite])
    const response = await postAgui(url, { threadId: "thread-agui-client-only" })
    expect(response.status).toBe(503)
    expect(await codeOf(response)).toBe("client_tool_store_unavailable")
  })

  test("permission + client park: refused with 503, even with the permission resume", async () => {
    const { url } = await startFixture([permissionWrite, clientWrite])
    const threadId = "thread-agui-mixed"

    const bare = await postAgui(url, { threadId })
    expect(bare.status).toBe(503)
    expect(await codeOf(bare)).toBe("client_tool_store_unavailable")

    const partial = await postAgui(url, {
      threadId,
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
    })
    expect(partial.status).toBe(503)
    expect(await codeOf(partial)).toBe("client_tool_store_unavailable")
  })
})

describe("the live-turn tap publishes the client's view", () => {
  test("no client park, and un-prefixed names for this run's client tools", async () => {
    const published: StreamChunk[] = []
    const producer = { publish: (chunk: StreamChunk) => published.push(chunk) }
    const raw: StreamChunk[] = [
      { type: "tool_call_args", data: { id: "call_1", name: "client_openPanel", delta: "{}" } },
      { type: "tool_call", id: "call_1", name: "client_openPanel", input: {} },
      { type: "tool_result", id: "call_0", name: "client_openPanel", output: "ok" },
      { type: "tool_call", id: "call_2", name: "client_other", input: {} },
      { type: "interrupt", data: clientPark },
      { type: "interrupt", data: { type: "client-tool-call", interruptId: "client-x" } },
      { type: "interrupt", data: permissionPark },
      { type: "done", output: null },
    ]
    let terminal: StreamChunk | undefined
    const yielded = await collect(
      __tapLiveTurnForTests(
        from(raw),
        producer as unknown as Parameters<typeof __tapLiveTurnForTests>[1],
        (chunk) => {
          terminal = chunk
        },
        new Set(["openPanel"]),
      ),
    )
    expect(published).toEqual([
      { type: "tool_call_args", data: { id: "call_1", name: "openPanel", delta: "{}" } },
      { type: "tool_call", id: "call_1", name: "openPanel", input: {} },
      { type: "tool_result", id: "call_0", name: "openPanel", output: "ok" },
      { type: "tool_call", id: "call_2", name: "client_other", input: {} },
      { type: "interrupt", data: permissionPark },
    ])
    // Downstream still gets the raw stream: normalizeB4Stream applies the
    // same view there exactly once, and observeInterrupts has already seen it.
    expect(yielded).toEqual(raw)
    expect(terminal).toEqual({ type: "done", output: null })
  })
})

describe("withoutClientToolParks", () => {
  const entry = (interruptId: string, value: unknown) => ({
    aliases: [interruptId],
    interruptId,
    resumeKey: null,
    value,
  })

  test("filters a client park and keeps a permission park", () => {
    const result = withoutClientToolParks({
      interrupts: [entry("perm-1", permissionPark), entry("client-call_1", clientPark)],
      malformed: false,
    })
    expect(result.interrupts.map((i) => i.interruptId)).toEqual(["perm-1"])
    expect(result.malformed).toBe(false)
  })

  test("a client-typed envelope missing its ids is dropped AND fails closed", () => {
    const result = withoutClientToolParks({
      interrupts: [
        entry("perm-1", permissionPark),
        entry("client-broken", { type: "client-tool-call", interruptId: "client-broken" }),
      ],
      malformed: false,
    })
    expect(result.interrupts.map((i) => i.interruptId)).toEqual(["perm-1"])
    expect(result.malformed).toBe(true)
  })

  test("carries malformed over from the full set", () => {
    expect(withoutClientToolParks({ interrupts: [], malformed: true }).malformed).toBe(true)
  })
})

async function postAgui(
  serverUrl: string,
  body: { threadId: string; resume?: unknown[] },
): Promise<Response> {
  return fetch(new URL(`/agui/${encodeURIComponent("/noop#graph")}`, serverUrl), {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ content: "hi", id: "m-1", role: "user" }],
      runId: "run-1",
      state: {},
      tools: [],
      ...body,
    }),
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    method: "POST",
  })
}

async function codeOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { details?: { code?: unknown } } }
  return body.error?.details?.code
}

async function readStateFrame(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("attach response had no body")
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const frame of buffer.split("\n\n")) {
        const lines = frame.split("\n")
        if (lines[0] !== "event: state") continue
        const data = lines.find((line) => line.startsWith("data: "))
        if (data) return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  throw new Error(`no state frame in: ${buffer}`)
}

async function startFixture(writes: readonly unknown[]): Promise<{ url: string }> {
  const tuple = {
    checkpoint: { channel_values: {}, id: "cp-1" },
    metadata: { "b4:checkpoint-routes": { checkpointId: "cp-1", routes: ["/noop#graph"] } },
    pendingWrites: writes,
  }
  const appRoot = await createFixtureApp({
    "b4.config.ts": `
      export default {
        approvals: { grants: "off" },
        checkpointer: {
          getTuple: async () => (${JSON.stringify(tuple)}),
        },
      };
    `,
    "package.json": '{"type":"module"}\n',
    "src/app/noop/index.ts": `
      export const graph = async () => ({ ok: true });
    `,
  })
  const server = await startRuntimeServer({ appRoot })
  servers.push(server)
  return { url: server.url }
}

async function seedRoute(serverUrl: string, threadId: string): Promise<void> {
  const response = await fetch(new URL(`/threads/${threadId}/runs/wait`, serverUrl), {
    body: JSON.stringify({ input: {}, route: "/noop#graph" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  expect(response.status).toBe(200)
}

async function postResume(serverUrl: string, threadId: string, body: unknown): Promise<Response> {
  return fetch(new URL(`/threads/${threadId}/resume`, serverUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

async function createFixtureApp(files: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-client-park-"))
  tempDirs.push(appRoot)
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(appRoot, relative)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, contents, "utf8")
  }
  return appRoot
}
