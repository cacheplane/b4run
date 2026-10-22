import { describe, expect, it } from "vitest"
import { consumeTurn } from "../src/lib/controller/turns.ts"
import type { StreamFrame } from "../src/lib/worker/wire.ts"

async function* frames(list: StreamFrame[], failAfter?: number): AsyncGenerator<StreamFrame> {
  let index = 0
  for (const frame of list) {
    if (failAfter !== undefined && index === failAfter) throw new Error("socket hang up")
    index += 1
    yield frame
  }
}

const gate = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "tool",
  detail: { toolName: "exportForReview", argsPreview: "{}", suggestedPattern: "exportForReview" },
}

describe("consumeTurn", () => {
  it("dispatches frames to handlers in order and reports a clean end", async () => {
    const seen: string[] = []
    const result = await consumeTurn(
      frames([
        { event: "tool_result", data: { name: "prepareReview", output: "{}" } },
        { event: "interrupt", data: gate },
        { event: "chunk", data: "text" },
        { event: "done", data: { output: {} } },
      ]),
      {
        onFirstFrame: async () => void seen.push("first"),
        onToolResult: async (name) => void seen.push(`tool:${name}`),
        onInterrupt: async (frame) => void seen.push(`interrupt:${frame.interruptId}`),
        onDone: async () => void seen.push("done"),
      },
    )
    expect(seen).toEqual(["first", "tool:prepareReview", "interrupt:perm-1", "done"])
    expect(result).toEqual({
      ended: "done",
      interrupts: [expect.objectContaining({ interruptId: "perm-1" })],
    })
  })

  it("reports a lost stream without throwing", async () => {
    const result = await consumeTurn(
      frames(
        [
          { event: "chunk", data: "x" },
          { event: "done", data: {} },
        ],
        1,
      ),
      {},
    )
    expect(result.ended).toBe("lost")
    expect(result.error).toMatch(/socket hang up/)
  })

  it("treats a stream that ends without done as lost", async () => {
    const result = await consumeTurn(frames([{ event: "chunk", data: "x" }]), {})
    expect(result.ended).toBe("lost")
  })

  it("ignores malformed interrupt frames but counts them", async () => {
    const result = await consumeTurn(
      frames([
        { event: "interrupt", data: { nope: true } },
        { event: "done", data: {} },
      ]),
      {},
    )
    expect(result.interrupts).toEqual([])
    expect(result.malformed).toBe(1)
  })

  it("ignores malformed tool_result frames but counts them", async () => {
    const result = await consumeTurn(
      frames([
        { event: "tool_result", data: { nope: true } },
        { event: "done", data: {} },
      ]),
      {},
    )
    expect(result.ended).toBe("done")
    expect(result.malformed).toBe(1)
  })

  it("reports handler_error when a handler throws, without consuming further frames", async () => {
    const seen: string[] = []
    const result = await consumeTurn(
      frames([
        { event: "tool_result", data: { name: "prepareReview", output: "{}" } },
        { event: "chunk", data: "text" },
        { event: "done", data: {} },
      ]),
      {
        onFirstFrame: async () => void seen.push("first"),
        onToolResult: async () => {
          throw new Error("handler exploded")
        },
        onDone: async () => void seen.push("done"),
      },
    )
    expect(seen).toEqual(["first"])
    expect(result.ended).toBe("handler_error")
    expect(result.error).toMatch(/handler exploded/)
  })
})

describe("consumeTurn and usage frames", () => {
  it("hands a usage frame to onUsage, and counts one that is not a usage as malformed", async () => {
    const seen: number[] = []
    const result = await consumeTurn(
      frames([
        {
          event: "usage",
          data: { model: "gpt-5-mini", usage_metadata: { input_tokens: 10, output_tokens: 2 } },
        },
        { event: "usage", data: { usage_metadata: { input_tokens: "ten" } } },
        { event: "done", data: { output: {} } },
      ]),
      { onUsage: async (frame) => void seen.push(frame.usage_metadata.input_tokens) },
    )
    expect(seen).toEqual([10])
    expect(result).toEqual({ ended: "done", interrupts: [], malformed: 1 })
  })
})
