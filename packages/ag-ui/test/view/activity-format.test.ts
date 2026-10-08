import { describe, expect, test } from "vitest"
import {
  countSources,
  countSteps,
  formatDuration,
  MAX_FIELD_CHARS,
  planProgress,
  reasoningLabel,
  stepDetailView,
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

describe("stepDetailView", () => {
  test("a flat object becomes rows: scalars as text, null as a dash, scalar arrays joined", () => {
    const view = stepDetailView(
      '{"id":"KSTP","n":2,"ok":true,"none":null,"ids":["A","B"],"empty":[]}',
      undefined,
    )
    expect(view.input).toEqual({
      kind: "fields",
      fields: [
        { key: "id", value: "KSTP" },
        { key: "n", value: "2" },
        { key: "ok", value: "true" },
        { key: "none", value: "—" },
        { key: "ids", value: "A, B" },
        { key: "empty", value: "—" },
      ],
    })
    expect(view.result).toBeUndefined()
    expect(view.raw).toEqual({ input: expect.stringContaining('"id": "KSTP"'), result: "" })
    expect(view.empty).toBe(false)
  })

  test("a long or multi-line field value shows its first line, cut, with its full length", () => {
    const content = `| Leg | From | To |\n${"x".repeat(200)}`
    const view = stepDetailView(JSON.stringify({ path: "a.md", content }), undefined)
    expect(view.input?.kind).toBe("fields")
    const fields = view.input?.kind === "fields" ? view.input.fields : []
    expect(fields[1]).toEqual({
      key: "content",
      value: `| Leg | From | To | … (${content.length} chars)`,
    })
    const long = "y".repeat(MAX_FIELD_CHARS + 1)
    const cut = stepDetailView(JSON.stringify({ q: long }), undefined).input
    expect(cut).toEqual({
      kind: "fields",
      fields: [
        { key: "q", value: `${"y".repeat(MAX_FIELD_CHARS)} … (${MAX_FIELD_CHARS + 1} chars)` },
      ],
    })
  })

  test("strings, scalars and scalar arrays read as text; nested values stay code", () => {
    expect(stepDetailView("", '"wrote 4 bytes"').result).toEqual({
      kind: "text",
      text: "wrote 4 bytes",
    })
    expect(stepDetailView("", "plain words").result).toEqual({ kind: "text", text: "plain words" })
    expect(stepDetailView("", "42").result).toEqual({ kind: "text", text: "42" })
    expect(stepDetailView("", '["a","b"]').result).toEqual({ kind: "text", text: "a, b" })
    expect(stepDetailView("", "[[1,2]]").result).toEqual({
      kind: "code",
      text: "[\n  [\n    1,\n    2\n  ]\n]",
    })
    expect(stepDetailView('{"a":{"b":{"c":1}}}', undefined).input?.kind).toBe("code")
  })

  test("one nested level reads as dotted keys", () => {
    expect(
      stepDetailView('{"data":{"subject":"aircraft","value":"2400"},"confidence":0.9}', undefined)
        .input,
    ).toEqual({
      kind: "fields",
      fields: [
        { key: "data.subject", value: "aircraft" },
        { key: "data.value", value: "2400" },
        { key: "confidence", value: "0.9" },
      ],
    })
  })

  test("a short list of objects reads as one group of rows each; a long one stays code", () => {
    expect(
      stepDetailView("", '[{"id":"KSTP","vfr":true},{"id":"KRST","vfr":false}]').result,
    ).toEqual({
      kind: "records",
      records: [
        [
          { key: "id", value: "KSTP" },
          { key: "vfr", value: "true" },
        ],
        [
          { key: "id", value: "KRST" },
          { key: "vfr", value: "false" },
        ],
      ],
    })
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ i })))
    expect(stepDetailView("", eleven).result?.kind).toBe("code")
    expect(stepDetailView("", '[{"a":1},2]').result?.kind).toBe("code")
    expect(stepDetailView("", '[{"a":1}]').raw).toEqual({
      input: "",
      result: '[\n  {\n    "a": 1\n  }\n]',
    })
  })

  test("an object with more than twelve keys reads better as JSON", () => {
    const wide = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]))
    expect(stepDetailView(JSON.stringify(wide), undefined).input?.kind).toBe("code")
  })

  test("raw is offered only when rows reshaped a value", () => {
    expect(stepDetailView("", '"text"').raw).toBeUndefined()
    expect(stepDetailView('{"a":{"b":{"c":1}}}', "done").raw).toBeUndefined()
    expect(stepDetailView('{"a":1}', '"ok"').raw).toEqual({ input: '{\n  "a": 1\n}', result: "" })
    expect(stepDetailView("[[1]]", '{"b":2}').raw).toEqual({
      input: "",
      result: '{\n  "b": 2\n}',
    })
  })

  test("nothing to show: empty text, an empty object, an empty array, a blank string", () => {
    for (const args of ["", "  ", "{}", "[]", '""']) {
      expect(stepDetailView(args, undefined)).toEqual({
        input: undefined,
        result: undefined,
        raw: undefined,
        empty: true,
      })
    }
  })
})
