import { expect, test } from "vitest"
import { normalizeRecording } from "../../../../../scripts/docs-captures/normalize"

const meta = {
  id: "navlog-test",
  provenance: "synthetic" as const,
  revisions: { app: "a".repeat(40), runtime: "b".repeat(40), example: "c".repeat(40) },
}
const recording = {
  format: "b4app-docs-private-v1",
  complete: true,
  appVersion: "test",
  recordedAt: "2026-11-05T00:00:00Z",
  epochAlias: "epoch-1",
  events: [
    {
      sourceSequence: 2,
      elapsedMs: 0,
      kind: "message.started",
      turnId: "private-turn",
      fields: {
        id: "private-item",
        nativeItemId: "native-item",
        role: "assistant",
        type: "agentMessage",
        provenance: "live",
        text: "",
      },
    },
    {
      sourceSequence: 3,
      elapsedMs: 1,
      kind: "turn.acknowledged",
      turnId: "private-turn",
      fields: { id: "private-turn", status: "running", submission: "acknowledged", outcome: null },
    },
    {
      sourceSequence: 5,
      elapsedMs: 2,
      kind: "message.delta",
      turnId: "private-turn",
      fields: { nativeItemId: "native-item", delta: "Hello" },
    },
    {
      sourceSequence: 6,
      elapsedMs: 3,
      kind: "message.completed",
      turnId: "private-turn",
      fields: {
        id: "private-item",
        nativeItemId: "native-item",
        role: "assistant",
        type: "agentMessage",
        provenance: "live",
        text: "Hello world",
      },
    },
    {
      sourceSequence: 7,
      elapsedMs: 4,
      kind: "turn.finished",
      turnId: "private-turn",
      fields: {
        id: "private-turn",
        status: "terminal",
        submission: "acknowledged",
        outcome: "completed",
      },
    },
  ],
}
test("normalizes only observed fields with stable aliases and exact deltas", () => {
  const capture = normalizeRecording(JSON.stringify(recording), meta)
  expect(capture.events[2]?.changes).toEqual([{ kind: "delta", itemId: "item-1", text: "Hello" }])
  expect(JSON.stringify(capture)).not.toContain("private-")
  expect(JSON.stringify(capture)).not.toContain("native-item")
  expect(capture.events[0]?.changes[0]).toMatchObject({
    kind: "item",
    item: { input: { available: false }, content: { available: true, value: "" } },
  })
})
test("rejects incomplete recordings and unresolved delta mappings", () => {
  expect(() =>
    normalizeRecording(JSON.stringify({ ...recording, complete: false }), meta),
  ).toThrow()
  const input = structuredClone(recording)
  input.events[2]!.fields.nativeItemId = "missing"
  expect(() => normalizeRecording(JSON.stringify(input), meta)).toThrow(/mapping/)
})
test("rejects secret fragments across streamed text", () => {
  const input = structuredClone(recording)
  input.events[0]!.fields.text = "sk-"
  input.events[2]!.fields.delta = "123456789abcdef"
  expect(() => normalizeRecording(JSON.stringify(input), meta)).toThrow(/secret/)
})
test("keeps observed custom-event JSON as inspectable content", () => {
  const input = structuredClone(recording)
  const custom = {
    ...input.events[3],
    fields: {
      id: "custom-item",
      nativeItemId: "custom-native",
      role: "tool",
      type: "subagent.step",
      provenance: "live",
      event: "subagent.step",
      data: { label: "Checking performance" },
    },
  }
  Reflect.set(custom, "kind", "tool.completed")
  Reflect.set(input.events, 3, custom)
  const capture = normalizeRecording(JSON.stringify(input), meta)
  expect(capture.events[3]?.changes[0]).toMatchObject({
    kind: "item",
    item: {
      name: "subagent.step",
      content: { available: true, value: { label: "Checking performance" } },
    },
  })
})
