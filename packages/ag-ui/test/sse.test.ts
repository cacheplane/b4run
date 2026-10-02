import { EventType } from "@ag-ui/core"
import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder"
import { decode } from "@ag-ui/proto"
import { describe, expect, test } from "vitest"
import { agUiContentType, encodeAgUiEvent } from "../src/sse.js"

const EVENT = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as const

/** The one frame `bytes` holds: 4-byte big-endian length, then the event. */
function decodeFrame(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  expect(bytes.length, "frame is exactly its declared length").toBe(4 + length)
  return decode(bytes.subarray(4))
}

describe("the SSE binding", () => {
  test.each([
    ["no Accept", undefined],
    ["text/event-stream", "text/event-stream"],
    ["protobuf listed at q=0", "text/event-stream, application/vnd.ag-ui.event+proto;q=0"],
  ])("is selected by %s", (_label, accept) => {
    expect(agUiContentType(accept)).toBe("text/event-stream")
    const text = new TextDecoder().decode(encodeAgUiEvent(EVENT, accept))
    expect(text.startsWith("data: ")).toBe(true)
    expect(text.endsWith("\n\n")).toBe(true)
    expect(JSON.parse(text.slice("data: ".length))).toEqual(EVENT)
  })
})

describe("the HTTP+protobuf binding", () => {
  test.each([
    ["the protobuf media type", "application/vnd.ag-ui.event+proto"],
    ["both, protobuf first", "application/vnd.ag-ui.event+proto, text/event-stream"],
    ["a wildcard range", "*/*"],
    ["an application wildcard", "application/*"],
  ])("is selected by %s", (_label, accept) => {
    expect(agUiContentType(accept)).toBe(AGUI_MEDIA_TYPE)
    expect(decodeFrame(encodeAgUiEvent(EVENT, accept))).toEqual(EVENT)
  })

  test("the media type is the one the spec names", () => {
    expect(AGUI_MEDIA_TYPE).toBe("application/vnd.ag-ui.event+proto")
  })
})
