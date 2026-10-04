// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { useB4Turns } from "../../src/copilotkit/useB4Turns.js"
import { FakeAgent } from "./fake-agent.js"

const started = (runId: string): BaseEvent =>
  ({ type: EventType.RUN_STARTED, threadId: "t", runId }) as BaseEvent
const finished = (runId: string): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    outcome: { type: "success" },
  }) as BaseEvent
const interrupted = (runId: string): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "command" }] },
  }) as BaseEvent

describe("useB4Turns", () => {
  test("folds the agent's events into turns and consumes markResuming on the next RUN_STARTED", () => {
    const agent = new FakeAgent()
    const { result } = renderHook(() => useB4Turns(agent as never, { now: () => 1 }))
    act(() => {
      agent.emit(started("r1"))
      agent.emit(interrupted("r1"))
    })
    expect(result.current.turns.turns[0]?.status).toBe("awaiting")
    act(() => result.current.markResuming())
    act(() => {
      agent.emit(started("r2"))
      agent.emit(finished("r2"))
    })
    expect(result.current.turns.turns).toHaveLength(1)
    expect(result.current.turns.turns[0]?.status).toBe("done")
    act(() => {
      agent.emit(started("r3"))
    })
    expect(result.current.turns.turns).toHaveLength(2) // no markResuming → a new turn
  })

  test("clearResuming forgets a mark whose resume never went out", () => {
    const agent = new FakeAgent()
    const { result } = renderHook(() => useB4Turns(agent as never, { now: () => 1 }))
    act(() => {
      agent.emit(started("r1"))
      agent.emit(finished("r1"))
    })
    act(() => {
      result.current.markResuming()
      result.current.clearResuming()
    })
    act(() => {
      agent.emit(started("r2"))
    })
    // A standing mark would glue r2 onto the done turn; cleared, it appends.
    expect(result.current.turns.turns).toHaveLength(2)
  })

  test("a new hiddenTools array literal on every render does not reset the view", () => {
    const agent = new FakeAgent()
    const { result, rerender } = renderHook(() =>
      useB4Turns(agent as never, { now: () => 1, hiddenTools: ["recall"] }),
    )
    act(() => {
      agent.emit(started("r1"))
    })
    rerender()
    rerender()
    expect(result.current.turns.turns).toHaveLength(1)
  })

  test("unsubscribes on unmount and re-subscribes, resetting, on an agent swap", () => {
    const first = new FakeAgent()
    const second = new FakeAgent()
    const { result, rerender, unmount } = renderHook(
      ({ agent }: { agent: FakeAgent }) => useB4Turns(agent as never, { now: () => 1 }),
      { initialProps: { agent: first } },
    )
    act(() => {
      first.emit(started("r1"))
    })
    expect(result.current.turns.turns).toHaveLength(1)
    expect(first.subscribers).toBe(1)

    rerender({ agent: second })
    expect(first.subscribers).toBe(0)
    expect(second.subscribers).toBe(1)
    expect(result.current.turns.turns).toEqual([])
    act(() => {
      first.emit(started("r9")) // the old agent no longer reaches the view
      second.emit(started("s1"))
    })
    expect(result.current.turns.turns.map((t) => t.runId)).toEqual(["s1"])

    unmount()
    expect(second.subscribers).toBe(0)
  })

  test("is empty without an agent", () => {
    const { result } = renderHook(() => useB4Turns(undefined))
    expect(result.current.turns.turns).toEqual([])
  })
})
