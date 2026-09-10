import { describe, expect, it } from "vitest"
import { createSseFrameParser } from "../src/lib/threads/sse-frames.js"

describe("createSseFrameParser", () => {
  it("emits a frame per complete block and buffers partial ones", () => {
    const parser = createSseFrameParser()
    expect(parser.push('event: state\ndata: {"live":false}\n\n')).toEqual([
      { event: "state", data: { live: false } },
    ])
    // A block split across two chunks yields nothing until it completes.
    expect(parser.push('event: chunk\ndata: "he')).toEqual([])
    expect(parser.push('llo"\n\n')).toEqual([{ event: "chunk", data: "hello" }])
  })

  it("ignores comment heartbeats and surfaces a bare retry block", () => {
    const parser = createSseFrameParser()
    expect(parser.push(": ping\n\n")).toEqual([])
    expect(parser.push("retry: 2100\n\n")).toEqual([{ event: "message", retry: 2100 }])
  })

  it("folds multi-line data per the SSE spec", () => {
    const parser = createSseFrameParser()
    expect(parser.push('event: note\ndata: {"a":1,\ndata: "b":2}\n\n')).toEqual([
      { event: "note", data: { a: 1, b: 2 } },
    ])
  })

  it.each(["\n", "\r\n", "\r"])("parses %j framing at every chunk boundary", (eol) => {
    const text = `event: done${eol}data: {"output":null}${eol}${eol}`
    for (let split = 0; split <= text.length; split += 1) {
      const parser = createSseFrameParser()
      expect([...parser.push(text.slice(0, split)), ...parser.push(text.slice(split))]).toEqual([
        { event: "done", data: { output: null } },
      ])
    }
  })

  it("does not repair malformed JSON by escaping a raw newline", () => {
    expect(createSseFrameParser().push('data: "a\ndata: b"\n\n')).toEqual([
      { event: "message", malformed: true, raw: '"a\nb"' },
    ])
  })

  it.each(["", "-1", "1.5", "1e3", "Infinity"])("ignores invalid retry value %j", (value) => {
    expect(createSseFrameParser().push(`retry: ${value}\n\n`)).toEqual([])
  })

  it("reports unparseable data rather than throwing", () => {
    const parser = createSseFrameParser()
    expect(parser.push("event: state\ndata: {not json}\n\n")).toEqual([
      { event: "state", raw: "{not json}", malformed: true },
    ])
  })
})
