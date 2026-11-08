import { describe, expect, test } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import type { Capture } from "../../../lib/turn-inspector/capture-types"
import { stateAt } from "../../../lib/turn-inspector/replay"
import fixture from "./__fixtures__/synthetic-capture.json"

describe("recorded turn contract", () => {
  test("replays prefixes in either direction without duplicating completed text", () => {
    const capture = parseCapture(JSON.stringify(fixture))
    expect(stateAt(capture, 2).items[0]?.content).toEqual({
      available: true,
      value: "Hello world",
    })
    expect(stateAt(capture, 1).items[0]?.content).toEqual({
      available: true,
      value: "Hello",
    })
    expect(stateAt(capture, -1).items).toEqual([])
    expect(stateAt(capture, 6).turns.map((t) => t.outcome)).toEqual(["completed", "cancelled"])
    expect(stateAt(capture, 5).requests[0]?.decision).toEqual({
      available: false,
    })
    expect(fixture.initial.items).toEqual([])
  })
  test("preserves a user message arriving before the turn state", () => {
    const input = structuredClone(fixture)
    input.events[0]?.changes.reverse()
    const parsed = parseCapture(JSON.stringify(input))
    expect(stateAt(parsed, 0).items[0]?.id).toBe("message-1")
  })
  test.each([
    [
      "version",
      (c: Capture) => {
        Reflect.set(c, "version", 2)
      },
    ],
    [
      "sequence",
      (c: Capture) => {
        c.events[1]!.sequence = 4
      },
    ],
    [
      "source sequence",
      (c: Capture) => {
        c.events[1]!.sourceSequence = 1
      },
    ],
    [
      "elapsed time",
      (c: Capture) => {
        c.events[1]!.elapsedMs = -1
      },
    ],
    [
      "missing item",
      (c: Capture) => {
        Reflect.set(c.events[1]!.changes[0]!, "itemId", "missing")
      },
    ],
    [
      "missing turn",
      (c: Capture) => {
        Reflect.set(Reflect.get(c.events[0]!.changes[1]!, "item"), "turnId", "missing")
      },
    ],
    [
      "duplicate moment",
      (c: Capture) => {
        c.moments.push(c.moments[0]!)
      },
    ],
    [
      "future moment item",
      (c: Capture) => {
        c.moments[0]!.itemId = "tool-2"
      },
    ],
    [
      "invalid revision",
      (c: Capture) => {
        c.revisions.app = "main"
      },
    ],
    [
      "invalid timestamp",
      (c: Capture) => {
        c.recordedAt = "yesterday"
      },
    ],
    [
      "terminal reversal",
      (c: Capture) => {
        const change = c.events[6]?.changes[0]
        if (change?.kind !== "turn") throw new Error("fixture turn missing")
        change.turn.id = "turn-1"
        change.turn.status = "running"
        change.turn.outcome = null
      },
    ],
    [
      "invented decision",
      (c: Capture) => {
        ;(
          c.events[3]!.changes[0] as Extract<
            Capture["events"][number]["changes"][number],
            { kind: "request" }
          >
        ).request.decision = {
          available: true,
          value: "once",
        }
      },
    ],
  ] as const)("rejects %s", (_, mutate) => {
    const input = structuredClone(fixture) as unknown as Capture
    mutate(input)
    expect(() => parseCapture(JSON.stringify(input))).toThrow()
  })
  test("bounds strings, nesting, and input bytes before replay", () => {
    expect(() => parseCapture(" ".repeat(20 * 1024 * 1024 + 1))).toThrow(/limit/)
    const input = structuredClone(fixture) as unknown as Capture
    input.events[1]!.changes[0] = {
      kind: "delta",
      itemId: "message-1",
      text: "x".repeat(1024 * 1024 + 1),
    }
    expect(() => parseCapture(JSON.stringify(input))).toThrow(/string/)
    expect(() =>
      parseCapture(
        JSON.stringify({
          nested: Array.from({ length: 33 }).reduce((x) => [x], {}),
        }),
      ),
    ).toThrow(/depth/)
  })
})
