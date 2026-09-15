import { expect, test } from "vitest"
import { createLiveTurnHub } from "../src/lib/dev/live-turn-hub.ts"
import { toNdjsonLine, toSseEvent } from "../src/lib/runtime/stream-types.ts"

test("identified chunks retain legacy SSE payload and metadata in NDJSON", () => {
  const chunk = { type: "chunk", data: "hello", messageId: "model-a" }

  expect(toSseEvent(chunk)).toBe('event: chunk\ndata: "hello"\n\n')
  expect(JSON.parse(toNdjsonLine(chunk))).toEqual(chunk)
})

test("live snapshots coalesce only matching message identities", () => {
  const hub = createLiveTurnHub()
  const producer = hub.open({
    threadId: "thread",
    routeKey: "/chat#agent",
    anchorRouteKeys: [],
    anchorCheckpointId: null,
    runStartedAt: "2026-09-15T00:00:00Z",
    resume: false,
    input: {},
  })
  const chunks = [
    { type: "chunk", data: "a1", messageId: "a" },
    { type: "chunk", data: "a2", messageId: "a" },
    { type: "chunk", data: "b", messageId: "b" },
    { type: "chunk", data: "legacy" },
    { type: "chunk", data: " tail" },
    { type: "chunk", data: "a3", messageId: "a" },
  ]
  for (const chunk of chunks) producer.publish(chunk)
  const attachment = hub.attach("thread")

  expect(attachment?.turn).toEqual([
    { type: "chunk", data: "a1a2", messageId: "a" },
    { type: "chunk", data: "b", messageId: "b" },
    { type: "chunk", data: "legacy tail" },
    { type: "chunk", data: "a3", messageId: "a" },
  ])
  attachment?.detach()
  hub.closeAll()
})
