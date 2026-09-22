import type { MiddlewareAfterHook, MiddlewareAfterRun } from "@b4run/sdk"
import { reject } from "@b4run/sdk"
import { describe, expect, test } from "vitest"
import { applyMiddlewareAfter, MiddlewareAfterError } from "../src/lib/dev/middleware-after.ts"
import type { StreamChunk } from "../src/lib/runtime/stream-types.ts"

const RUN: Omit<MiddlewareAfterRun, "finalMessage"> = {
  assistantId: "/chat#agent",
  context: { tenant: "acme" },
  messages: [{ role: "user", content: "hello" }],
  routeId: "/chat",
  runId: "rn-1",
  threadId: "th-1",
}

async function* toAsync(items: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const item of items) yield item
}

async function collect(
  chunks: StreamChunk[],
  hook: MiddlewareAfterHook,
): Promise<{ readonly out: StreamChunk[]; readonly error: unknown }> {
  const out: StreamChunk[] = []
  try {
    for await (const chunk of applyMiddlewareAfter(toAsync(chunks), hook, RUN)) out.push(chunk)
    return { error: undefined, out }
  } catch (error) {
    return { error, out }
  }
}

const TOOL_TURN: StreamChunk[] = [
  { type: "chunk", data: "Let me ", messageId: "m1" },
  { type: "chunk", data: "look.", messageId: "m1" },
  { type: "message_end", data: { messageId: "m1" } },
  { type: "tool_call", id: "c1", name: "lookup", input: { q: "x" } },
  { type: "tool_result", id: "c1", name: "lookup", output: "42" },
  { type: "chunk", data: "The answer ", messageId: "m2" },
  { type: "chunk", data: "is 42.", messageId: "m2" },
  { type: "message_end", data: { messageId: "m2" } },
  { type: "done", output: { ok: true } },
]

describe("applyMiddlewareAfter", () => {
  test("receives the final assistant message and the middleware run context", async () => {
    const seen: MiddlewareAfterRun[] = []
    const { error, out } = await collect(TOOL_TURN, (run) => {
      seen.push(run)
    })
    expect(error).toBeUndefined()
    expect(seen).toEqual([{ ...RUN, finalMessage: "The answer is 42." }])
    expect(out).toEqual(TOOL_TURN)
  })

  test("text before a tool call streams live and is not the final message", async () => {
    const yielded: StreamChunk[] = []
    let finalMessage: string | undefined
    const source = toAsync(TOOL_TURN)
    const wrapped = applyMiddlewareAfter(
      source,
      (run) => {
        finalMessage = run.finalMessage
        // Everything up to and including the tool result has already been
        // handed downstream by the time the hook runs.
        expect(yielded).toEqual(TOOL_TURN.slice(0, 5))
      },
      RUN,
    )
    for await (const chunk of wrapped) yielded.push(chunk)
    expect(finalMessage).toBe("The answer is 42.")
  })

  test("a streamed argument fragment releases held text like the tool call it precedes", async () => {
    const turn: StreamChunk[] = [
      { type: "chunk", data: "Let me ", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "tool_call_args", data: { id: "c1", name: "lookup", delta: '{"q":' } },
      { type: "tool_call_args", data: { id: "c1", name: "lookup", delta: '"x"}' } },
      { type: "tool_call", id: "c1", name: "lookup", input: { q: "x" } },
      { type: "tool_result", id: "c1", name: "lookup", output: "42" },
      { type: "chunk", data: "Done.", messageId: "m2" },
      { type: "message_end", data: { messageId: "m2" } },
      { type: "done", output: null },
    ]
    const yielded: StreamChunk[] = []
    const wrapped = applyMiddlewareAfter(toAsync(turn), () => undefined, RUN)
    for await (const chunk of wrapped) yielded.push(chunk)
    // The first fragment proves the message was not final, so the text goes
    // out ahead of the fragment rather than after the whole tool call.
    expect(yielded.slice(0, 4)).toEqual(turn.slice(0, 4))
  })

  test("replaces the final message, keeping its model message identity", async () => {
    const { error, out } = await collect(TOOL_TURN, () => ({ finalMessage: "REPLACED" }))
    expect(error).toBeUndefined()
    expect(out).toEqual([
      ...TOOL_TURN.slice(0, 5),
      { type: "chunk", data: "REPLACED", messageId: "m2" },
      { type: "message_end", data: { messageId: "m2" } },
      { type: "done", output: { ok: true } },
    ])
  })

  test("an empty replacement suppresses the final message", async () => {
    const { error, out } = await collect(TOOL_TURN, () => ({ finalMessage: "" }))
    expect(error).toBeUndefined()
    expect(out).toEqual([...TOOL_TURN.slice(0, 5), { type: "done", output: { ok: true } }])
  })

  test("a run that produced no final text still runs the hook and can add one", async () => {
    const chunks: StreamChunk[] = [
      { type: "tool_call", id: "c1", name: "lookup", input: {} },
      { type: "tool_result", id: "c1", name: "lookup", output: "42" },
      { type: "done", output: null },
    ]
    const seen: string[] = []
    const { error, out } = await collect(chunks, (run) => {
      seen.push(run.finalMessage)
      return { finalMessage: "Done." }
    })
    expect(error).toBeUndefined()
    expect(seen).toEqual([""])
    expect(out).toEqual([
      chunks[0],
      chunks[1],
      { type: "chunk", data: "Done." },
      { type: "done", output: null },
    ])
  })

  test("reject() fails the run before `done` with a MiddlewareAfterError", async () => {
    const { error, out } = await collect(TOOL_TURN, () =>
      reject(422, { error: "unknown component" }),
    )
    expect(out).toEqual(TOOL_TURN.slice(0, 5))
    expect(error).toBeInstanceOf(MiddlewareAfterError)
    expect((error as MiddlewareAfterError).message).toBe("unknown component")
    expect((error as MiddlewareAfterError).code).toBe("middleware_rejected")
    expect((error as MiddlewareAfterError).status).toBe(422)
  })

  test("reject() message falls back sensibly for string, message and empty bodies", async () => {
    const message = async (body: unknown) =>
      ((await collect(TOOL_TURN, () => reject(400, body))).error as Error).message
    expect(await message("plain")).toBe("plain")
    expect(await message({ message: "from message" })).toBe("from message")
    expect(await message(undefined)).toBe("The final assistant message was rejected by middleware")
  })

  test("a hook that throws fails the run with its own error", async () => {
    const boom = new Error("boom")
    const { error } = await collect(TOOL_TURN, () => {
      throw boom
    })
    expect(error).toBe(boom)
  })

  test("a new model message flushes the previous one live", async () => {
    const chunks: StreamChunk[] = [
      { type: "chunk", data: "first", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "chunk", data: "second", messageId: "m2" },
      { type: "message_end", data: { messageId: "m2" } },
      { type: "done", output: null },
    ]
    const seen: string[] = []
    const { out } = await collect(chunks, (run) => {
      seen.push(run.finalMessage)
      return { finalMessage: "second!" }
    })
    expect(seen).toEqual(["second"])
    expect(out).toEqual([
      chunks[0],
      chunks[1],
      { type: "chunk", data: "second!", messageId: "m2" },
      chunks[3],
      chunks[4],
    ])
  })

  test("unidentified tokens are buffered as one message", async () => {
    const chunks: StreamChunk[] = [
      { type: "chunk", data: "a" },
      { type: "chunk", data: "b" },
      { type: "done", output: null },
    ]
    const seen: string[] = []
    const { out } = await collect(chunks, (run) => {
      seen.push(run.finalMessage)
      return { finalMessage: "ab!" }
    })
    expect(seen).toEqual(["ab"])
    expect(out).toEqual([{ type: "chunk", data: "ab!" }, chunks[2]])
  })

  test("capability chunks pass through immediately while text stays buffered", async () => {
    const chunks: StreamChunk[] = [
      { type: "chunk", data: "answer", messageId: "m1" },
      { type: "plan_update", data: { todos: [] } },
      { type: "done", output: null },
    ]
    const yielded: StreamChunk[] = []
    const wrapped = applyMiddlewareAfter(
      toAsync(chunks),
      (run) => {
        expect(yielded).toEqual([chunks[1]])
        expect(run.finalMessage).toBe("answer")
      },
      RUN,
    )
    for await (const chunk of wrapped) yielded.push(chunk)
    expect(yielded).toEqual([chunks[1], chunks[0], chunks[2]])
  })

  test("a parked turn does not run the hook", async () => {
    const chunks: StreamChunk[] = [
      { type: "chunk", data: "Deploying?", messageId: "m1" },
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "done", output: null },
    ]
    let calls = 0
    const { error, out } = await collect(chunks, () => {
      calls += 1
    })
    expect(error).toBeUndefined()
    expect(calls).toBe(0)
    expect(out).toEqual(chunks)
  })

  test("a stream that ends without `done` still runs the hook", async () => {
    const chunks: StreamChunk[] = [{ type: "chunk", data: "tail" }]
    const seen: string[] = []
    const { out } = await collect(chunks, (run) => {
      seen.push(run.finalMessage)
    })
    expect(seen).toEqual(["tail"])
    expect(out).toEqual(chunks)
  })
})
