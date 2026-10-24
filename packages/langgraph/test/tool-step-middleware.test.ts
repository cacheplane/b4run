import { createRequire } from "node:module"
import { ToolMessage } from "@langchain/core/messages"
import { Command, GraphInterrupt, isCommand } from "@langchain/langgraph"
import { expect, test } from "vitest"
import { toolStepMiddleware } from "../src/ui.ts"

function request(id = "call-1", signal?: AbortSignal) {
  return {
    toolCall: { id, name: "lookup", args: { query: id }, type: "tool_call" },
    tool: undefined,
    state: { messages: [] },
    runtime: { ...(signal ? { signal } : {}) },
  } as never
}

async function wrap(
  handler: () => Promise<ToolMessage | Command>,
  options = {},
  signal?: AbortSignal,
) {
  const hook = toolStepMiddleware(options).wrapToolCall
  if (!hook) throw Error("Missing wrapper")
  return hook(request("call-1", signal), handler)
}

test("persists an owned settled step while preserving every ToolMessage field", async () => {
  const original = new ToolMessage({
    content: "found",
    tool_call_id: "call-1",
    id: "result-1",
    name: "lookup",
    artifact: { data: 1 },
    status: "success",
    response_metadata: { token: 1 },
    additional_kwargs: { keep: "yes" },
  })
  let received: unknown

  const result = await wrap(async () => original, {
    display: {
      lookup: {
        done: (_args: unknown, message: ToolMessage) => {
          received = message
          return "Found"
        },
        icon: "custom",
      },
    },
  })

  expect(received).toBe(original)
  expect(result).not.toBe(original)
  expect(result).toMatchObject({
    content: "found",
    id: "result-1",
    artifact: { data: 1 },
    response_metadata: { token: 1 },
    additional_kwargs: {
      keep: "yes",
      b4_step: {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Found",
        icon: "custom",
        startedAt: expect.any(Number),
        settledAt: expect.any(Number),
      },
    },
  })
  expect((result as ToolMessage).additional_kwargs.b4_step).not.toHaveProperty("toolCallId")
  expect(original.additional_kwargs).toEqual({ keep: "yes" })
})

test("ordinary thrown errors become readable failed messages with error codes", async () => {
  const result = await wrap(async () => {
    throw Object.assign(new Error("offline"), { code: "OFFLINE" })
  })

  expect(result).toMatchObject({
    status: "error",
    content: "offline",
    tool_call_id: "call-1",
    additional_kwargs: {
      b4_step: { status: "failed", error: { message: "offline", code: "OFFLINE" } },
    },
  })
})

test("error status overrides completion and explicit denied steps survive successful messages", async () => {
  const error = await wrap(
    async () =>
      new ToolMessage({
        content: "bad",
        tool_call_id: "call-1",
        status: "error",
        additional_kwargs: { b4_step: { v: 1, kind: "server", status: "completed" } },
      }),
  )
  const denied = await wrap(
    async () =>
      new ToolMessage({
        content: "denied",
        tool_call_id: "call-1",
        additional_kwargs: { b4_step: { v: 1, kind: "server", status: "denied" } },
      }),
  )

  expect(error).toMatchObject({
    additional_kwargs: { b4_step: { status: "failed", error: { message: "bad" } } },
  })
  expect(denied).toMatchObject({ additional_kwargs: { b4_step: { status: "denied" } } })
})

test("display failures fall back to a bare step", async () => {
  const broken = () => {
    throw Error("display")
  }

  const result = await wrap(
    async () => new ToolMessage({ content: "ok", tool_call_id: "call-1" }),
    { display: { lookup: { running: broken, done: broken, sources: broken } } },
  )

  expect(result).toMatchObject({
    content: "ok",
    additional_kwargs: { b4_step: { status: "completed" } },
  })
  expect((result as ToolMessage).additional_kwargs.b4_step).not.toHaveProperty("label")
})

test("Commands preserve object and tuple updates and unrelated state", async () => {
  const message = new ToolMessage({ content: "ok", tool_call_id: "call-1" })
  const other = new ToolMessage({ content: "other", tool_call_id: "other" })
  for (const update of [
    { messages: [other, message], count: 7 },
    [
      ["count", 7],
      ["messages", [other, message]],
    ] as [string, unknown][],
  ]) {
    const original = new Command({ update, goto: "next", graph: Command.PARENT, resume: "resume" })

    const result = await wrap(async () => original)

    expect(result).not.toBe(original)
    expect(result).toMatchObject({
      goto: original.goto,
      graph: original.graph,
      resume: original.resume,
    })
    const messages = Array.isArray((result as Command).update)
      ? ((result as Command).update as [string, unknown][]).find(([key]) => key === "messages")?.[1]
      : ((result as Command).update as { messages: unknown }).messages
    expect(messages).toMatchObject([
      other,
      { additional_kwargs: { b4_step: { status: "completed" } } },
    ])
    expect(message.additional_kwargs).toEqual({})
  }
})

test("Commands without an unambiguous result pass through unchanged", async () => {
  for (const messages of [
    [],
    [new ToolMessage({ content: "other", tool_call_id: "other" })],
    [
      new ToolMessage({ content: "a", tool_call_id: "call-1" }),
      new ToolMessage({ content: "b", tool_call_id: "call-1" }),
    ],
  ]) {
    const command = new Command({ update: { messages }, goto: "next" })

    const result = await wrap(async () => command)

    expect(result).toBe(command)
  }
})

test("graph interrupts and abort reasons are preserved without fabricated results", async () => {
  const interrupt = new GraphInterrupt([])
  const controller = new AbortController()
  const reason = new Error("cancelled")

  await expect(
    wrap(async () => {
      throw interrupt
    }),
  ).rejects.toBe(interrupt)
  await expect(
    wrap(
      async () => {
        controller.abort(reason)
        return new ToolMessage({ content: "late", tool_call_id: "call-1" })
      },
      {},
      controller.signal,
    ),
  ).rejects.toBe(reason)
})

test("explicit failed details are retained over display callbacks", async () => {
  const original = new ToolMessage({
    content: "failed",
    tool_call_id: "call-1",
    additional_kwargs: {
      b4_step: {
        v: 1,
        kind: "server",
        status: "failed",
        label: "Explicit failure",
        builtin: "web_search",
        error: { message: "specific", code: "EXPLICIT" },
      },
    },
  })

  const result = await wrap(async () => original, {
    display: { lookup: { failed: () => "Display failure" } },
  })

  expect(result).toMatchObject({
    additional_kwargs: {
      b4_step: {
        label: "Explicit failure",
        builtin: "web_search",
        status: "failed",
        error: { message: "specific", code: "EXPLICIT" },
      },
    },
  })
})

test("all graph bubble-up signals pass through by identity", async () => {
  const { GraphBubbleUp } = await import("@langchain/langgraph")
  const bubble = new GraphBubbleUp("bubble")

  await expect(
    wrap(async () => {
      throw bubble
    }),
  ).rejects.toBe(bubble)
})

test("a thrown abort keeps the original exception and emits only cancellation", async () => {
  const { RunnableLambda } = await import("@langchain/core/runnables")
  const controller = new AbortController()
  const reason = new Error("original abort")
  const events: Record<string, unknown>[] = []
  const callback = {
    name: "capture",
    awaitHandlers: true,
    handleCustomEvent(_name: string, value: Record<string, unknown>) {
      events.push(value)
    },
  }
  const runnable = RunnableLambda.from(async () =>
    wrap(
      async () => {
        controller.abort(reason)
        throw reason
      },
      {},
      controller.signal,
    ),
  )

  await expect(runnable.invoke("go", { callbacks: [callback] })).rejects.toBe(reason)

  expect(events.map((event) => event.status)).toEqual(["running", "cancelled"])
})

test("a returned cancelled step remains cancelled", async () => {
  const message = new ToolMessage({
    content: "stopped",
    tool_call_id: "call-1",
    additional_kwargs: { b4_step: { v: 1, kind: "server", status: "cancelled", label: "Stopped" } },
  })

  const result = await wrap(async () => message)

  expect(result).toMatchObject({
    additional_kwargs: { b4_step: { status: "cancelled", label: "Stopped" } },
  })
})

test("recognizes genuine CJS Commands across the ESM module boundary", async () => {
  const { Command: CjsCommand } = createRequire(import.meta.url)("@langchain/langgraph") as {
    Command: typeof Command
  }
  const message = new ToolMessage({ content: "found", tool_call_id: "call-1" })
  const other = new ToolMessage({ content: "other", tool_call_id: "other" })
  for (const update of [
    { messages: [other, message], count: 7 },
    [
      ["count", 7],
      ["messages", [other, message]],
    ] as [string, unknown][],
  ]) {
    const original = new CjsCommand({
      update,
      goto: "next",
      graph: CjsCommand.PARENT,
      resume: "resume",
    })
    expect(original).not.toBeInstanceOf(Command)
    expect(isCommand(original)).toBe(true)

    const result = await wrap(async () => original)

    expect(result).not.toBe(original)
    expect(isCommand(result)).toBe(true)
    expect(result).toMatchObject({
      goto: original.goto,
      graph: original.graph,
      resume: original.resume,
    })
    const messages = Array.isArray((result as Command).update)
      ? ((result as Command).update as [string, unknown][]).find(([key]) => key === "messages")?.[1]
      : ((result as Command).update as { messages: unknown }).messages
    expect(messages).toMatchObject([
      other,
      { additional_kwargs: { b4_step: { status: "completed" } } },
    ])
    expect(message.additional_kwargs).toEqual({})
  }
  const noResult = new CjsCommand({ update: { count: 7 }, goto: "next" })

  expect(await wrap(async () => noResult)).toBe(noResult)
}, 30_000)

test("coded and uncoded thrown errors retain failed display details in persisted and live steps", async () => {
  const { RunnableLambda } = await import("@langchain/core/runnables")
  for (const code of [undefined, "OFFLINE"]) {
    const error = Object.assign(new Error("offline"), code ? { code } : {})
    const sources = [{ id: "failure-source", kind: "record" as const, title: "Service status" }]
    const events: Record<string, unknown>[] = []
    const callback = {
      name: "capture-failure",
      awaitHandlers: true,
      handleCustomEvent(_name: string, value: Record<string, unknown>) {
        events.push(value)
      },
    }
    const runnable = RunnableLambda.from(async () =>
      wrap(
        async () => {
          throw error
        },
        {
          display: {
            lookup: {
              failed: (_args: unknown, text: string) => `Failed: ${text}`,
              sources: () => sources,
            },
          },
        },
      ),
    )

    const result = (await runnable.invoke("go", { callbacks: [callback] })) as ToolMessage

    const expected = {
      status: "failed",
      label: "Failed: offline",
      sources,
      error: { message: "offline", ...(code ? { code } : {}) },
    }
    expect(result.additional_kwargs.b4_step).toMatchObject(expected)
    expect(events.at(-1)).toMatchObject({ ...expected, toolCallId: "call-1" })
    expect(result.status).toBe("error")
    expect(result.content).toBe("offline")
  }
})
