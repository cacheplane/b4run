import { type BaseEvent, EventType } from "@ag-ui/core"
import type { B4ToolStep } from "@b4run/sdk"
import { TOOL_STEP_FIXTURES, type ToolStepFixtureEvent } from "@b4run/sdk/testing"
import { describe, expect, it } from "vitest"
import { stepLabel } from "../../src/view/labels.ts"
import { toContractSteps } from "../../src/view/tool-steps.ts"
import { EMPTY_TURNS, reduceTurns, type ToolStep, type TurnsView } from "../../src/view/turns.ts"

/**
 * The fixture events as the AG-UI events `reduceTurns` takes: each
 * `RUN_STARTED` gets the thread id and a run id of its own (a second run is
 * the resume), and a run opens first when the fixture starts none.
 */
function toEvents(events: readonly ToolStepFixtureEvent[]): readonly BaseEvent[] {
  const opened = events.some((event) => event.type === EventType.RUN_STARTED)
  const stream: readonly ToolStepFixtureEvent[] = opened
    ? events
    : [{ type: EventType.RUN_STARTED }, ...events]
  let runs = 0
  return stream.map(
    (event) =>
      (event.type === EventType.RUN_STARTED
        ? { ...event, threadId: "th-contract", runId: `rn-${++runs}` }
        : event) as BaseEvent,
  )
}

/** Folds a fixture's events with a deterministic clock. */
function foldFixture(events: readonly ToolStepFixtureEvent[]): TurnsView {
  let clock = 0
  return toEvents(events).reduce(
    (view, event) => reduceTurns(view, event, { now: () => (clock += 1000) }),
    EMPTY_TURNS,
  )
}

/**
 * The fields the contract compares: every field the view stores. Times are
 * each side's own clock, and `parentToolCallId` is not kept by the view.
 */
function compared(step: B4ToolStep) {
  return {
    status: step.status,
    kind: step.kind,
    ...(step.builtin !== undefined ? { builtin: step.builtin } : {}),
    ...(step.provider !== undefined ? { provider: step.provider } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.icon !== undefined ? { icon: step.icon } : {}),
    ...(step.queries !== undefined ? { queries: step.queries } : {}),
    ...(step.sources !== undefined ? { sources: step.sources } : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    ...(step.decision !== undefined ? { decision: step.decision } : {}),
  }
}

const comparedAll = (steps: Readonly<Record<string, B4ToolStep>>) =>
  Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, compared(step)]))

describe("reduceTurns conforms to the b4.step fixture corpus", () => {
  for (const fixture of TOOL_STEP_FIXTURES) {
    it(fixture.name, () => {
      const view = foldFixture(fixture.events)

      const steps = toContractSteps(view)

      expect(comparedAll(steps)).toEqual(comparedAll(fixture.expected.steps))
    })
  }
})

describe("toContractSteps", () => {
  it("maps view statuses to contract terms and defaults a failed step's error", () => {
    const view = foldFixture([
      { type: "TOOL_CALL_START", toolCallId: "p", toolCallName: "a" },
      { type: "TOOL_CALL_START", toolCallId: "r", toolCallName: "a" },
      { type: "TOOL_CALL_END", toolCallId: "r" },
      { type: "TOOL_CALL_START", toolCallId: "d", toolCallName: "a" },
      { type: "TOOL_CALL_RESULT", toolCallId: "d", messageId: "m", content: "ok" },
      { type: "RUN_ERROR" },
    ])

    const steps = toContractSteps(view)

    expect(steps.p).toMatchObject({ v: 1, kind: "server", status: "failed" })
    expect(steps.p?.error).toEqual({ message: "Tool call did not finish" })
    expect(steps.r?.status).toBe("failed")
    expect(steps.d?.status).toBe("completed")
    expect(steps.d).not.toHaveProperty("error")
  })

  it("reads steps inside a subagent's nested turn", () => {
    const view = foldFixture([
      { type: "TOOL_CALL_START", toolCallId: "task-1", toolCallName: "task" },
      { type: "SUBAGENT_STARTED", subagentRunId: "task-1", name: "researcher" } as never,
      {
        type: "TOOL_CALL_START",
        toolCallId: "k1",
        toolCallName: "readDoc",
        subagentRunId: "task-1",
        metadata: { "b4.step": { v: 1, kind: "server", status: "running", label: "Reading" } },
      } as never,
    ])

    const steps = toContractSteps(view)

    expect(steps.k1).toMatchObject({ status: "running", label: "Reading" })
  })
})

describe("cancelled tool steps", () => {
  const cancelled: ToolStep = {
    kind: "tool",
    id: "c1",
    name: "exportData",
    status: "cancelled",
    args: "",
    startedAt: 1,
    settledAt: 2,
  }

  it("read 'Cancelled <tool>' unless the server labelled them, and no override runs", () => {
    const overrides = { exportData: { done: () => "Exported", running: () => "Exporting" } }

    expect(stepLabel(cancelled, overrides)).toBe("Cancelled exportData")
    expect(stepLabel({ ...cancelled, label: "Export stopped" }, overrides)).toBe("Export stopped")
  })

  it("never count as failures", () => {
    const view = foldFixture([
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "exportData" },
      { type: "RUN_FINISHED", outcome: { type: "cancelled" } },
    ])

    expect(view.turns[0]?.steps[0]).toMatchObject({ status: "cancelled" })
    expect(view.turns[0]?.failed).toBe(0)
    expect(view.turns[0]?.status).toBe("stopped")
  })
})
