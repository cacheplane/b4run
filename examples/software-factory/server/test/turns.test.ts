import { describe, expect, it } from "vitest"
import { consumeTurn } from "../src/controller/turns.ts"
import type { StreamFrame } from "../src/worker/wire.ts"

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
})
