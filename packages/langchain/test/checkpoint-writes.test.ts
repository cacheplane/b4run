import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import { trackCheckpointWrites } from "../src/checkpoint-writes.ts"

/** A MemorySaver whose writes land only when the test releases them. */
class GatedSaver extends MemorySaver {
  release: () => void = () => undefined
  landed = false
  override async putWrites(...args: Parameters<MemorySaver["putWrites"]>): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
    await super.putWrites(...args)
    this.landed = true
  }
}

const config = { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c1" } }

describe("trackCheckpointWrites", () => {
  it("preserves a failed owned write and its derived rejection until the graph observes it", async () => {
    const failure = new Error("durable-write-failed")
    class FailingSaver extends MemorySaver {
      override async putWrites(): Promise<void> {
        throw failure
      }
    }
    const tracked = trackCheckpointWrites(new FailingSaver())
    const write = tracked.saver.putWrites(config, [["x", 1]], "task")
    // Pinned LangGraph keeps this exact rejecting child in its task barrier,
    // but awaits it only after other tasks complete.
    const child = write.then(
      () => "unexpected",
      (error) => {
        throw error
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(child).rejects.toBe(failure)
    await expect(write.catch((error) => error)).resolves.toBe(failure)
    let finalized = 0
    await expect(
      write.finally(() => {
        finalized++
      }),
    ).rejects.toBe(failure)
    expect(finalized).toBe(1)
    await tracked.settled()
  })

  it("settles only after a write already in flight has landed", async () => {
    const saver = new GatedSaver()
    const tracked = trackCheckpointWrites(saver)

    const write = tracked.saver.putWrites(config, [["__interrupt__", { id: "i" }]], "task")
    let settled = false
    const settling = tracked.settled().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)

    saver.release()
    await Promise.all([write, settling])
    expect(saver.landed).toBe(true)
    expect(settled).toBe(true)
  })

  it("waits for a write issued just after the failure it drains", async () => {
    const saver = new MemorySaver()
    const tracked = trackCheckpointWrites(saver)
    let landed = false

    // Issued from a promise continuation, the way LangGraph issues its
    // remaining checkpoint writes after a run's stream has rejected.
    void Promise.resolve().then(() =>
      tracked.saver.putWrites(config, [["x", 1]], "task").then(() => {
        landed = true
      }),
    )
    await tracked.settled()

    expect(landed).toBe(true)
  })

  it("hands back one tracker per saver, forwarding everything else untouched", async () => {
    const saver = new MemorySaver()
    const tracked = trackCheckpointWrites(saver)

    expect(trackCheckpointWrites(saver)).toBe(tracked)
    expect(tracked.saver).toBeInstanceOf(MemorySaver)
    await tracked.saver.putWrites(config, [["x", 1]], "task")
    expect(await tracked.saver.getTuple({ configurable: { thread_id: "missing" } })).toBeUndefined()
    await expect(tracked.settled()).resolves.toBeUndefined()
  })
})
