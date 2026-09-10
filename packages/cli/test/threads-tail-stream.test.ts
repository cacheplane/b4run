import { describe, expect, it, vi } from "vitest"
import { consumeAttachStream } from "../src/lib/threads/tail-stream.js"

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(text))
      c.close()
    },
  })
}
const DURABLE =
  'event: state\ndata: {"live":false,"status":"idle","interrupts":[],"turn":null,"values":null}\n\n' +
  'event: done\ndata: {"output":null}\n\n' +
  "retry: 2100\n\n"

describe("consumeAttachStream", () => {
  it("ends cleanly on done and reports the retry hint", async () => {
    const out: string[] = []
    const result = await consumeAttachStream({ body: bodyOf(DURABLE), write: (l) => out.push(l) })
    expect(result.outcome).toBe("done")
    expect(result.retryMs).toBe(2100)
    expect(out.join("\n")).toContain("idle")
  })

  it.each(["done", "detached"])(
    "stops and cancels the transport after %s without waiting for EOF",
    async (event) => {
      let cancelled = false
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          c.enqueue(
            new TextEncoder().encode(`retry: 2100\n\nevent: ${event}\ndata: {"reason":"lag"}\n\n`),
          )
        },
        cancel() {
          cancelled = true
        },
      })
      const result = consumeAttachStream({ body, write: () => {} })
      try {
        await vi.waitFor(() => expect(cancelled).toBe(true))
        expect(await result).toMatchObject({ outcome: event, retryMs: 2100 })
        expect(body.locked).toBe(false)
      } finally {
        if (!cancelled) controller?.close()
        await result
      }
    },
  )

  it.each(["done", "detached"])("preserves %s if transport cleanup rejects", async (event) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`))
      },
      cancel() {
        return Promise.reject(new Error("transport already closed"))
      },
    })
    await expect(consumeAttachStream({ body, write: () => {} })).resolves.toMatchObject({
      outcome: event,
    })
    expect(body.locked).toBe(false)
  })

  it("renders the same text whether token chunks are in the snapshot or live tail", async () => {
    const render = async (snapshot: string[], live: string[]) => {
      const turn = snapshot.map((data) => ({ type: "chunk", data }))
      const state = { live: true, status: "busy", turn, values: null, input: null, interrupts: [] }
      const wire =
        `event: state\ndata: ${JSON.stringify(state)}\n\n` +
        live.map((data) => `event: chunk\ndata: ${JSON.stringify(data)}\n\n`).join("") +
        'event: done\ndata: {"output":null}\n\n'
      let output = ""
      await consumeAttachStream({
        body: bodyOf(wire),
        write: (text) => {
          output += text
        },
      })
      return output
    }
    const snapshot = await render(["wor", "king"], [])
    expect(snapshot).toContain("working\n[done]")
    expect(await render(["wor"], ["k", "ing"])).toBe(snapshot)
    expect(await render([], ["wor", "k", "ing"])).toBe(snapshot)
  })

  it("cancels the transport and releases its reader when output fails", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: chunk\ndata: "text"\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      consumeAttachStream({
        body,
        write: () => {
          throw new Error("output closed")
        },
      }),
    ).rejects.toThrow("output closed")
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  it("renders malformed chunk data as a diagnostic and continues to done", async () => {
    let output = ""
    const result = await consumeAttachStream({
      body: bodyOf("event: chunk\ndata: {bad}\n\nevent: done\ndata: {}\n\n"),
      write: (text) => {
        Buffer.byteLength(text)
        output += text
      },
    })
    expect(result.outcome).toBe("done")
    expect(output).toContain("[malformed chunk] {bad}")
    expect(output).toContain("[done]")
  })

  it("writes only text for an incomplete snapshot chunk", async () => {
    const state = { live: true, turn: [{ type: "chunk" }] }
    let output = ""
    await consumeAttachStream({
      body: bodyOf(`event: state\ndata: ${JSON.stringify(state)}\n\nevent: done\ndata: {}\n\n`),
      write: (text) => {
        Buffer.byteLength(text)
        output += text
      },
    })
    expect(output).toContain("[done]")
  })

  it("reports a stream that ends without done as truncated", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: state\ndata: {"live":true,"turn":[]}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("truncated")
  })

  it("reports a detached stream with its reason", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: detached\ndata: {"reason":"capacity"}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("detached")
    expect(result.reason).toBe("capacity")
  })

  it("emits raw frames when json mode is on", async () => {
    const out: string[] = []
    await consumeAttachStream({ body: bodyOf(DURABLE), json: true, write: (l) => out.push(l) })
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ event: "state" })
  })
})
