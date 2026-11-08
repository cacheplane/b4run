import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { decode } from "@ag-ui/proto"
import { B4_TURN_METADATA_KEY, readPersistedTurnEnd } from "@b4run/sdk"
import { AIMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  END,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { afterEach, expect, it } from "vitest"
import { z } from "zod"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.ts"
import { routeCheckpointer } from "../src/lib/runtime/checkpoint-route-provenance.ts"
import {
  chatFixtureApp,
  fakeMemoryStore,
  fakePermissionsStore,
  inMemoryFilesystem,
  memoryThreadsStore,
} from "./helpers/fetch-entry-fixture.ts"
import { buildStaticModulesForFixture, cleanup } from "./helpers/static-modules-fixture.ts"

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  cleanup.push(() => release())
  return { promise, release }
}
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function fixture(
  resume = false,
  opaque?: "success" | "failure" | "observe",
  failFinalStatus = false,
) {
  const entered = barrier(),
    held = barrier(),
    writeEntered = barrier(),
    writeHeld = barrier(),
    statusEntered = barrier(),
    statusHeld = barrier()
  let opaqueFinished = false
  let toolFinished = false,
    next = 0,
    models = 0,
    ownerDisposed = 0,
    ownerReleased = 0
  class HeldSaver extends MemorySaver {
    override async put(...args: Parameters<MemorySaver["put"]>) {
      if (toolFinished) {
        writeEntered.release()
        await writeHeld.promise
      }
      return super.put(...args)
    }
  }
  const saver = new HeldSaver(),
    threadId = "owned",
    route = opaque ? "/chat#workflow" : "/chat#agent"
  const raw = tool(
    async (_input, config) => {
      if (resume)
        interrupt({
          interruptId: "owned-permission",
          type: "permission-request",
          kind: "tool",
          detail: { toolName: "work", suggestedPattern: "work" },
        })
      entered.release()
      try {
        await held.promise
        expect(config.signal?.aborted).toBe(false)
        return "settled"
      } finally {
        toolFinished = true
      }
    },
    { name: "work", description: "held native work", schema: z.object({}) },
  )
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("model", () => {
      models++
      return {
        messages: [
          new AIMessage({ content: "", tool_calls: [{ name: "work", id: "work", args: {} }] }),
        ],
      }
    })
    .addNode("tools", new ToolNode([raw]))
    .addNode("next", () => {
      next++
      return { messages: [new AIMessage("too late")] }
    })
    .addEdge(START, "model")
    .addEdge("model", "tools")
    .addEdge("tools", "next")
    .addEdge("next", END)
    .compile({ checkpointer: routeCheckpointer(saver, route) })
  const key = `__b4_stop_${crypto.randomUUID().replaceAll("-", "")}`
  Reflect.set(globalThis, key, {
    graph,
    opaque: async (_input: unknown, context: { signal: AbortSignal; stopSignal?: AbortSignal }) => {
      entered.release()
      try {
        await held.promise
        expect(context.signal.aborted).toBe(false)
        if (opaque === "failure") throw new Error("independent opaque error")
        if (opaque === "observe") context.stopSignal?.throwIfAborted()
        return { cancelled: true }
      } finally {
        opaqueFinished = true
      }
    },
  })
  cleanup.push(() => {
    Reflect.deleteProperty(globalThis, key)
  })
  const appRoot = await chatFixtureApp()
  await writeFile(
    join(appRoot, "src/app/chat/index.ts"),
    `export const ${opaque ? "workflow" : "agent"} = globalThis[${JSON.stringify(key)}].${opaque ? "opaque" : "graph"}\n`,
  )
  const modules = await buildStaticModulesForFixture(appRoot)
  const { store: threadsStore } = memoryThreadsStore()
  const updateStatus = threadsStore.updateStatus.bind(threadsStore)
  threadsStore.updateStatus = async (...args) => {
    if (failFinalStatus && (toolFinished || opaqueFinished) && args[1] !== "busy") {
      statusEntered.release()
      await statusHeld.promise
      throw new Error("independent status persistence failed")
    }
    return updateStatus(...args)
  }
  const slots = new Set<string>()
  const admission = () => {
    let owned: string | undefined,
      released = false
    const controller = new AbortController()
    return {
      signal: controller.signal,
      tryAcquire: async (id: string) => {
        if (owned === id) return true
        if (released || slots.has(id)) return false
        slots.add(id)
        owned = id
        return true
      },
      release: async () => {
        if (released) return
        released = true
        if (owned) {
          slots.delete(owned)
          ownerReleased++
        }
        controller.abort(new Error("admission released"))
      },
    }
  }
  if (resume) {
    await threadsStore.createThread({
      thread_id: threadId,
      metadata: { route, parked_route: route },
    })
    await graph.invoke(
      { messages: [{ role: "user", content: "park" }] },
      { configurable: { thread_id: threadId } },
    )
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config: { backends: { filesystem: inMemoryFilesystem() } },
    modules,
    requestStores: (request) => ({
      checkpointer: saver,
      threadsStore,
      memoryStore: fakeMemoryStore(),
      permissionsStore: fakePermissionsStore(),
      runAdmission: admission(),
      dispose: async () => {
        if (request.headers.get("x-owner") === "run") ownerDisposed++
      },
    }),
  })
  cleanup.push(() => handler.close())
  cleanup.push(() => {
    held.release()
    writeHeld.release()
    statusHeld.release()
  })
  return {
    handler,
    entered,
    held,
    writeEntered,
    writeHeld,
    statusEntered,
    statusHeld,
    saver,
    threadId,
    route,
    slots,
    get models() {
      return models
    },
    get next() {
      return next
    },
    get toolFinished() {
      return toolFinished
    },
    get ownerDisposed() {
      return ownerDisposed
    },
    get ownerReleased() {
      return ownerReleased
    },
  }
}

function request(mode: string, route: string, signal?: AbortSignal, owner = true) {
  const agui = mode.startsWith("agui")
  const path = agui
    ? `/agui/${encodeURIComponent(route)}`
    : `/threads/owned/${mode === "resume" ? "resume" : `runs/${mode}`}`
  const body = agui
    ? {
        threadId: "owned",
        runId: "run",
        messages: [{ id: "u", role: "user", content: "work" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }
    : mode === "resume"
      ? {
          route,
          resume: [{ interruptId: "owned-permission", status: "resolved", payload: "once" }],
        }
      : { route, input: { messages: [{ role: "user", content: "work" }] } }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-owner": owner ? "run" : "probe",
      accept: mode === "agui-proto" ? "application/vnd.ag-ui.event+proto" : "text/event-stream",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}
function events(bytes: Uint8Array, proto = false): Record<string, unknown>[] {
  if (!proto)
    return new TextDecoder()
      .decode(bytes)
      .split("\n\n")
      .flatMap((frame) => {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
        return data
          ? [
              {
                ...JSON.parse(data),
                __event: frame
                  .split("\n")
                  .find((line) => line.startsWith("event: "))
                  ?.slice(7),
              },
            ]
          : []
      })
  const out: Record<string, unknown>[] = []
  let offset = 0
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
    offset += 4
    out.push(decode(bytes.subarray(offset, offset + length)) as Record<string, unknown>)
    offset += length
  }
  return out
}

it.each(["stream", "wait", "resume", "agui-sse", "agui-proto"])(
  "%s holds native work, checkpoint writes and request resources through one settled terminal",
  async (mode) => {
    const f = await fixture(mode === "resume")
    let settled = false
    const responsePromise = f.handler.fetch(request(mode, f.route))
    const consumption = responsePromise
      .then(async (response) => ({
        status: response.status,
        bytes: new Uint8Array(await response.arrayBuffer()),
      }))
      .then((value) => {
        settled = true
        return value
      })
    await f.entered.promise
    const ack = await f.handler.fetch(
      new Request("http://localhost/threads/owned/cancel", { method: "POST" }),
    )
    expect(ack.status).toBe(200)
    expect(await ack.json()).toEqual({ status: "interrupted", thread_id: "owned" })
    await tick()
    expect(settled).toBe(false)
    expect(f.toolFinished).toBe(false)
    expect(f.ownerDisposed).toBe(0)
    expect(f.slots.has("owned")).toBe(true)
    const thread = await f.handler.fetch(new Request("http://localhost/threads/owned"))
    expect(await thread.json()).toMatchObject({ status: "busy" })
    const conflict = await f.handler.fetch(request("stream", f.route, undefined, false))
    expect(conflict.status).toBe(409)
    f.held.release()
    await f.writeEntered.promise
    await tick()
    expect(f.toolFinished).toBe(true)
    expect(settled).toBe(false)
    expect(f.ownerDisposed).toBe(0)
    expect(f.slots.has("owned")).toBe(true)
    expect((await f.handler.fetch(request("stream", f.route, undefined, false))).status).toBe(409)
    f.writeHeld.release()
    const response = await consumption
    expect(f.next).toBe(0)
    if (mode === "wait") {
      expect(response.status).toBe(409)
      expect(JSON.parse(new TextDecoder().decode(response.bytes)).error.details.code).toBe(
        "run_cancelled",
      )
    } else {
      const frames = events(response.bytes, mode === "agui-proto")
      const terminals = frames.filter((frame) =>
        mode.startsWith("agui")
          ? frame.type === "RUN_FINISHED" || frame.type === "RUN_ERROR"
          : frame.__event === "done",
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toMatchObject(
        mode.startsWith("agui")
          ? { type: "RUN_FINISHED", outcome: { type: "cancelled" } }
          : { output: { cancelled: true } },
      )
    }
    await expect.poll(() => f.ownerDisposed).toBe(1)
    expect(f.slots.size).toBe(0)
    const head = await f.saver.getTuple({ configurable: { thread_id: "owned", checkpoint_ns: "" } })
    expect(
      readPersistedTurnEnd(
        ((head?.metadata ?? {}) as Record<string, unknown>)[B4_TURN_METADATA_KEY],
      )?.status,
    ).toBe("stopped")
  },
  30_000,
)

it.each(["request", "response"])(
  "an AG-UI %s disconnect requests soft Stop while native execution retains its stores",
  async (mode) => {
    const f = await fixture()
    const controller = new AbortController()
    const response = await f.handler.fetch(request("agui-sse", f.route, controller.signal))
    await f.entered.promise
    const consumed = mode === "request" ? response.arrayBuffer() : undefined
    if (mode === "request") controller.abort()
    else await response.body?.cancel()
    await tick()
    expect(f.ownerDisposed).toBe(0)
    expect(f.slots.has("owned")).toBe(true)
    expect((await f.handler.fetch(request("stream", f.route, undefined, false))).status).toBe(409)
    f.held.release()
    await f.writeEntered.promise
    expect(f.ownerDisposed).toBe(0)
    f.writeHeld.release()
    await consumed
    await expect.poll(() => f.ownerDisposed).toBe(1)
    expect(f.next).toBe(0)
    expect(f.slots.size).toBe(0)
  },
  30_000,
)

it.each(["success", "failure", "observe"] as const)(
  "HTTP wait preserves an opaque %s after a Stop request",
  async (mode) => {
    const f = await fixture(false, mode)
    let settled = false
    const response = f.handler.fetch(request("wait", f.route)).then((value) => {
      settled = true
      return value
    })
    await f.entered.promise
    expect(
      (
        await f.handler.fetch(
          new Request("http://localhost/threads/owned/cancel", { method: "POST" }),
        )
      ).status,
    ).toBe(200)
    await tick()
    expect(settled).toBe(false)
    expect((await f.handler.fetch(request("stream", f.route, undefined, false))).status).toBe(409)
    f.held.release()
    const result = await response
    expect(result.status).toBe(mode === "success" ? 200 : mode === "failure" ? 500 : 409)
    const body = await result.json()
    if (mode === "success") expect(body).toEqual({ cancelled: true })
    if (mode === "failure") expect(JSON.stringify(body)).toContain("independent opaque error")
    if (mode === "observe")
      expect(body).toMatchObject({ error: { details: { code: "run_cancelled" } } })
    await expect.poll(() => f.ownerDisposed).toBe(1)
  },
)

it("an AG-UI preflight disconnect dispatches no native model or tool work", async () => {
  const f = await fixture(),
    controller = new AbortController()
  controller.abort()
  const response = await f.handler.fetch(request("agui-sse", f.route, controller.signal))
  expect(response.status).not.toBe(200)
  expect(f.models).toBe(0)
  expect(f.toolFinished).toBe(false)
  await response.arrayBuffer()
  await expect.poll(() => f.ownerDisposed).toBe(1)
  expect(f.slots.size).toBe(0)
})

it.each(["agui-sse", "agui-proto"])(
  "%s keeps a natural opaque result distinct from an observed Stop",
  async (mode) => {
    const f = await fixture(false, "success")
    const response = f.handler.fetch(request(mode, f.route))
    await f.entered.promise
    expect(
      (
        await f.handler.fetch(
          new Request("http://localhost/threads/owned/cancel", { method: "POST" }),
        )
      ).status,
    ).toBe(200)
    f.held.release()
    const result = await response
    const frames = events(new Uint8Array(await result.arrayBuffer()), mode === "agui-proto")
    expect(frames.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } })
    const thread = await f.handler.fetch(new Request("http://localhost/threads/owned"))
    expect(await thread.json()).toMatchObject({ status: "idle" })
  },
)

it.each(["stream", "wait", "resume", "agui-sse", "agui-proto"])(
  "%s reports a rejected final status write instead of a clean Stop",
  async (mode) => {
    const f = await fixture(mode === "resume", undefined, true)
    let settled = false,
      attachedSettled = false
    const consumption = f.handler
      .fetch(request(mode, f.route))
      .then(async (response) => ({
        status: response.status,
        bytes: new Uint8Array(await response.arrayBuffer()),
      }))
      .then((value) => {
        settled = true
        return value
      })
    await f.entered.promise
    const attachment =
      mode === "wait"
        ? undefined
        : await f.handler.fetch(new Request("http://localhost/threads/owned/runs/stream"))
    if (attachment) expect(attachment.status).toBe(200)
    const attached = attachment?.arrayBuffer().then((bytes) => {
      attachedSettled = true
      return events(new Uint8Array(bytes))
    })
    expect(
      (
        await f.handler.fetch(
          new Request("http://localhost/threads/owned/cancel", { method: "POST" }),
        )
      ).status,
    ).toBe(200)
    f.held.release()
    await f.writeEntered.promise
    f.writeHeld.release()
    await f.statusEntered.promise
    await tick()
    expect(settled).toBe(false)
    expect(attachedSettled).toBe(false)
    expect(f.ownerDisposed).toBe(0)
    expect(f.ownerReleased).toBe(0)
    expect((await f.handler.fetch(request("stream", f.route, undefined, false))).status).toBe(409)
    f.statusHeld.release()
    const response = await consumption
    if (mode === "wait") {
      expect(response.status).toBe(500)
      expect(JSON.parse(new TextDecoder().decode(response.bytes))).toMatchObject({
        error: { message: "independent status persistence failed", kind: "execution_error" },
      })
    } else {
      const frames = events(response.bytes, mode === "agui-proto")
      const terminal = frames.filter((frame) =>
        mode.startsWith("agui")
          ? frame.type === "RUN_ERROR" || frame.type === "RUN_FINISHED"
          : frame.__event === "done",
      )
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toMatchObject(
        mode.startsWith("agui")
          ? { type: "RUN_ERROR", message: "independent status persistence failed" }
          : { output: { error: "independent status persistence failed" } },
      )
    }
    if (attached) {
      const terminal = (await attached).filter((frame) => frame.__event === "done")
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toMatchObject({
        output: { error: "independent status persistence failed" },
      })
    }
    await expect.poll(() => f.ownerDisposed).toBe(1)
    expect(f.ownerReleased).toBe(1)
    expect(f.next).toBe(0)
    const head = await f.saver.getTuple({ configurable: { thread_id: "owned", checkpoint_ns: "" } })
    expect(
      readPersistedTurnEnd(
        ((head?.metadata ?? {}) as Record<string, unknown>)[B4_TURN_METADATA_KEY],
      ),
    ).toMatchObject({ status: "failed", error: "independent status persistence failed" })
  },
  30_000,
)

it.each(["stream", "wait", "agui-sse", "agui-proto"])(
  "%s preserves a primary source error when its final status write also fails",
  async (mode) => {
    const f = await fixture(false, "failure", true)
    const consumption = f.handler.fetch(request(mode, f.route)).then(async (response) => ({
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
    }))
    await f.entered.promise
    await f.handler.fetch(new Request("http://localhost/threads/owned/cancel", { method: "POST" }))
    f.held.release()
    await f.statusEntered.promise
    f.statusHeld.release()
    const response = await consumption
    const body =
      mode === "wait"
        ? new TextDecoder().decode(response.bytes)
        : JSON.stringify(events(response.bytes, mode === "agui-proto"))
    expect(body).toContain("independent opaque error")
    expect(body).not.toContain("independent status persistence failed")
    await expect.poll(() => f.ownerDisposed).toBe(1)
  },
  30_000,
)
