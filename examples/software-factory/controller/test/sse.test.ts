import { describe, expect, it } from "vitest"
import { parseBlock, parseSse } from "../src/lib/worker/sse.ts"

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const frames = []
  for await (const frame of parseSse(stream)) frames.push(frame)
  return frames
}

describe("parseSse", () => {
  it("yields event name and parsed JSON data per blank-line block", async () => {
    const frames = await collect(
      streamOf(
        'event: tool_call\ndata: {"name":"x","input":{}}\n\n',
        'event: done\ndata: {"output":{}}\n\n',
      ),
    )
    expect(frames).toEqual([
      { event: "tool_call", data: { name: "x", input: {} } },
      { event: "done", data: { output: {} } },
    ])
  })

  it("reassembles a block split across chunks and ignores ping comments", async () => {
    const frames = await collect(streamOf(": ping\n\nevent: chu", 'nk\ndata: "par', 'tial"\n\n'))
    expect(frames).toEqual([{ event: "chunk", data: "partial" }])
  })

  it("keeps non-JSON data as a string and defaults the event name", () => {
    expect(parseBlock("data: hello")).toEqual({ event: "message", data: "hello" })
    expect(parseBlock(": only a comment")).toBeNull()
  })

  it("parses blocks delimited by CRLF, including one split mid-delimiter across chunks", async () => {
    const frames = await collect(
      streamOf('event: a\r\ndata: "one"\r\n\r', '\nevent: b\r\ndata: "two"\r\n\r\n'),
    )
    expect(frames).toEqual([
      { event: "a", data: "one" },
      { event: "b", data: "two" },
    ])
  })

  it("cancels the source stream when the consumer stops early", async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: first\ndata: 1\n\n"))
        controller.enqueue(encoder.encode("event: second\ndata: 2\n\n"))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    })

    for await (const frame of parseSse(stream)) {
      expect(frame).toEqual({ event: "first", data: 1 })
      break
    }

    expect(cancelled).toBe(true)
  })
})
