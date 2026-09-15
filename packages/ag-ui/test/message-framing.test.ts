import { expect, test } from "vitest"
import { toAguiEvents } from "../src/outbound.ts"
import type { B4AgentStreamChunk } from "../src/types.ts"

async function collect(chunks: B4AgentStreamChunk[], error?: Error) {
  async function* source() {
    yield* chunks
    if (error) throw error
  }
  const events = []
  for await (const event of toAguiEvents(source(), { threadId: "thread", runId: "run" }))
    events.push(event)
  return events
}

const token = (messageId: string, data: string) => ({ type: "token", messageId, data })
const end = (messageId: string) => ({ type: "message_end", data: { messageId } })

test("interleaved model output remains two independently framed JSON messages", async () => {
  const events = await collect([
    token("a", '{"a":'),
    token("b", '{"b":'),
    token("a", "1}"),
    end("a"),
    { type: "tool_result", data: { id: "tool-a", name: "first", output: "ok" } },
    token("b", "2}"),
    end("b"),
    { type: "done" },
  ])
  const starts = events.filter((e) => e.type === "TEXT_MESSAGE_START")
  const texts = starts.map((start) =>
    events
      .flatMap((e) =>
        e.type === "TEXT_MESSAGE_CONTENT" && e.messageId === start.messageId ? [e.delta] : [],
      )
      .join(""),
  )

  expect(texts.map((text) => JSON.parse(text))).toEqual([{ a: 1 }, { b: 2 }])
  for (const start of starts) {
    expect(
      events.filter((e) => e.type === "TEXT_MESSAGE_END" && e.messageId === start.messageId),
    ).toHaveLength(1)
  }
})

test("model completion separates sequential messages without tool boundaries", async () => {
  const events = await collect([token("a", "first"), end("a"), token("b", "second"), end("b")])

  expect(events.filter((e) => e.type === "TEXT_MESSAGE_START")).toHaveLength(2)
  expect(events.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(2)
})

test.each(["done", "interrupt", "exhausted", "error"])(
  "%s closes all open model messages once",
  async (terminal) => {
    const chunks = [token("a", "first"), token("b", "second")]
    const tail =
      terminal === "done"
        ? [{ type: "done" }]
        : terminal === "interrupt"
          ? [
              { type: "interrupt", data: { interruptId: "approval", kind: "tool" } },
              token("a", "ignored"),
              { type: "done" },
            ]
          : []
    const events = await collect(
      [...chunks, ...tail],
      terminal === "error" ? new Error("failure") : undefined,
    )

    expect(events.filter((e) => e.type === "TEXT_MESSAGE_START")).toHaveLength(2)
    expect(events.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(2)
    expect(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT")).toHaveLength(2)
    expect(events.at(-1)?.type).toBe(terminal === "error" ? "RUN_ERROR" : "RUN_FINISHED")
  },
)

test("empty output and unknown or duplicate completions do not affect other messages", async () => {
  const events = await collect([
    token("empty", ""),
    end("empty"),
    token("a", "one"),
    end("unknown"),
    token("a", "two"),
    end("a"),
    end("a"),
    { type: "done" },
  ])

  expect(events.filter((e) => e.type === "TEXT_MESSAGE_START")).toHaveLength(1)
  expect(events.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1)
  expect(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual([
    "one",
    "two",
  ])
})

test("anonymous text retains boundaries and cannot merge into identified output", async () => {
  const events = await collect([
    { type: "token", data: "legacy" },
    token("a", "first"),
    { type: "capability.unknown", data: {} },
    token("a", "second"),
    end("a"),
    { type: "token", data: "tail" },
    { type: "done" },
  ])
  const starts = events.filter((e) => e.type === "TEXT_MESSAGE_START")
  const texts = starts.map((start) =>
    events
      .flatMap((e) =>
        e.type === "TEXT_MESSAGE_CONTENT" && e.messageId === start.messageId ? [e.delta] : [],
      )
      .join(""),
  )

  expect(texts).toEqual(["legacy", "firstsecond", "tail"])
})
