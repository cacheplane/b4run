import { describe, expect, test } from "vitest"
import {
  countSources,
  countSteps,
  formatDuration,
  planProgress,
  reasoningLabel,
  summaryLine,
} from "../../src/view/activity-format.js"
import type { ToolStep, TurnView } from "../../src/view/turns.js"

/**
 * `Partial` that also accepts an explicit `undefined`, so a case can unset a
 * default (`endedAt: undefined`); {@link compact} then drops the key, which
 * `exactOptionalPropertyTypes` requires of the built view.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const tool = (o: Loose<ToolStep> & { id: string; name: string }): ToolStep =>
  compact<ToolStep>({ kind: "tool", status: "done", args: "", startedAt: 0, settledAt: 1000, ...o })
const turn = (o: Loose<TurnView>): TurnView =>
  compact<TurnView>({
    runId: "r",
    status: "done",
    startedAt: 0,
    endedAt: 72_000,
    steps: [],
    text: "",
    approvals: [],
    failed: 0,
    ...o,
  })

describe("formatDuration", () => {
  test("uses <1s, Ns, Nm Ms and never claims <1s for unknown", () => {
    expect(formatDuration(0)).toBe("<1s")
    expect(formatDuration(999)).toBe("<1s")
    expect(formatDuration(12_000)).toBe("12s")
    expect(formatDuration(72_000)).toBe("1m 12s")
    expect(formatDuration(600_000)).toBe("10m 0s")
    expect(formatDuration(Number.NaN)).toBeUndefined()
    expect(formatDuration(-5)).toBeUndefined()
  })
})

describe("summaryLine", () => {
  test("working shows the newest running label and the elapsed time", () => {
    const t = turn({
      status: "working",
      endedAt: undefined,
      steps: [
        tool({ id: "a", name: "recall", label: "Checked memory", startedAt: 0 }),
        tool({
          id: "b",
          name: "searchCorpus",
          status: "running",
          label: "Searching the corpus",
          startedAt: 500,
          settledAt: undefined,
        }),
      ],
    })
    expect(summaryLine(t, 12_400)).toEqual({
      text: "Searching the corpus",
      meta: "· 12s",
      live: true,
    })
  })
  test("working with no running step falls back to Working", () => {
    expect(summaryLine(turn({ status: "working", endedAt: undefined }), 400)).toEqual({
      text: "Working",
      meta: "· <1s",
      live: true,
    })
  })
  test("the active label goes through stepLabel: overrides win, an unlabelled step reads Using x…", () => {
    const t = turn({
      status: "working",
      endedAt: undefined,
      steps: [tool({ id: "a", name: "searchCorpus", status: "running", settledAt: undefined })],
    })
    expect(summaryLine(t, 400).text).toBe("Using searchCorpus…")
    expect(summaryLine(t, 400, { searchCorpus: { running: () => "Looking things up" } }).text).toBe(
      "Looking things up",
    )
    const labelled = turn({ ...t, steps: [{ ...(t.steps[0] as ToolStep), label: "Searching" }] })
    expect(summaryLine(labelled, 400).text).toBe("Searching")
    expect(
      summaryLine(labelled, 400, { searchCorpus: { running: () => "Looking things up" } }).text,
    ).toBe("Looking things up")
  })
  test("awaiting reads Waiting for your approval", () => {
    expect(summaryLine(turn({ status: "awaiting", endedAt: undefined }), 38_000)).toEqual({
      text: "Waiting for your approval",
      meta: "· 38s",
      live: false,
    })
  })
  test("done counts steps, sources and failures", () => {
    const t = turn({
      steps: [
        tool({ id: "a", name: "searchCorpus", sources: [{ title: "a.md" }, { title: "b.md" }] }),
        tool({ id: "b", name: "readDoc", sources: [{ title: "c.md" }] }),
        tool({ id: "c", name: "writeFile" }),
      ],
    })
    expect(summaryLine(t, 999_999)).toEqual({
      text: "Worked for 1m 12s",
      meta: "· 3 steps · 3 sources",
      live: false,
    })
    expect(summaryLine(turn({ ...t, status: "failed", failed: 1 }), 0).meta).toBe(
      "· 3 steps · 3 sources · 1 failed",
    )
    expect(summaryLine(turn({ steps: [tool({ id: "a", name: "x" })] }), 0).meta).toBe("· 1 step")
  })
  test("stopped reads Stopped after d, or just Stopped when the duration is unknown", () => {
    expect(summaryLine(turn({ status: "stopped", endedAt: 41_000 }), 0)).toEqual({
      text: "Stopped after 41s",
      meta: "",
      live: false,
    })
    expect(
      summaryLine(turn({ status: "stopped", endedAt: undefined, startedAt: 5000 }), 0),
    ).toEqual({
      text: "Stopped",
      meta: "",
      live: false,
    })
  })
  test("done with an unknown duration reads Worked and drops the time", () => {
    expect(summaryLine(turn({ status: "done", endedAt: undefined, startedAt: 5000 }), 0).text).toBe(
      "Worked",
    )
  })
})

describe("counts and labels", () => {
  test("countSteps counts a subagent as one step plus each of its nested steps", () => {
    const nested = turn({
      steps: [tool({ id: "n1", name: "readDoc" }), tool({ id: "n2", name: "readDoc" })],
    })
    const t = turn({
      steps: [
        tool({ id: "a", name: "x" }),
        {
          kind: "subagent",
          id: "s",
          name: "researcher",
          status: "done",
          startedAt: 0,
          turn: nested,
        },
      ],
    })
    expect(countSteps(t)).toBe(4)
    expect(countSources(t)).toBe(0)
  })
  test("planProgress and reasoningLabel", () => {
    expect(
      planProgress([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3 })
    expect(
      reasoningLabel({
        kind: "reasoning",
        id: "r",
        text: "hmm",
        status: "streaming",
        startedAt: 0,
      }),
    ).toBe("Thinking…")
    expect(
      reasoningLabel({
        kind: "reasoning",
        id: "r",
        text: "hmm",
        status: "done",
        startedAt: 0,
        settledAt: 4000,
      }),
    ).toBe("Thought for 4s")
    expect(
      reasoningLabel({
        kind: "reasoning",
        id: "r",
        text: "",
        status: "done",
        startedAt: 0,
        settledAt: 4000,
      }),
    ).toBe("Thought for 4s")
    expect(
      reasoningLabel({ kind: "reasoning", id: "r", text: "hmm", status: "done", startedAt: 0 }),
    ).toBe("Show reasoning")
  })
})
