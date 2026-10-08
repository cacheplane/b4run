// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { useB4Turns } from "../../../src/react/copilotkit/useB4Turns.js"
import { summaryLine } from "../../../src/view/activity-format.js"
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

  test("a replayed event's timestamp is its clock; live events without one use the configured clock", () => {
    const agent = new FakeAgent()
    let clock = 5_000_000
    const { result } = renderHook(() => useB4Turns(agent as never, { now: () => clock }))
    const t0 = 1_700_000_000_000
    act(() => {
      // A restored thread: the server replays the run with each event stamped.
      agent.emit({ ...started("r1"), timestamp: t0 } as BaseEvent)
      agent.emit({ ...finished("r1"), timestamp: t0 + 3 * 60_000 + 5_000 } as BaseEvent)
    })
    const restored = result.current.turns.turns[0]
    expect(restored?.startedAt).toBe(t0)
    expect(restored && summaryLine(restored, Date.now()).text).toBe("Worked for 3m 5s")

    // A live run after the replay carries no stamp: the configured clock drives it.
    act(() => {
      agent.emit(started("r2"))
    })
    clock += 2_000
    act(() => {
      agent.emit(finished("r2"))
    })
    const live = result.current.turns.turns[1]
    expect(live?.startedAt).toBe(5_000_000)
    expect(live && summaryLine(live, clock).text).toBe("Worked for 2s")
  })

  test("a restored turn still working ticks against the live clock from its stamped start", () => {
    const agent = new FakeAgent()
    const { result } = renderHook(() => useB4Turns(agent as never))
    const t0 = Date.now() - 90_000
    act(() => {
      agent.emit({ ...started("r1"), timestamp: t0 } as BaseEvent)
    })
    const turn = result.current.turns.turns[0]
    expect(turn?.status).toBe("working")
    expect(turn && summaryLine(turn, t0 + 90_000).meta).toBe("· 1m 30s")
  })

  test("is empty without an agent", () => {
    const { result } = renderHook(() => useB4Turns(undefined))
    expect(result.current.turns.turns).toEqual([])
  })
})
