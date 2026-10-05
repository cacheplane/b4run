import { describe, expect, it } from "vitest"
import { BUILT_IN_GROUP_LABELS, groupSteps, stepLabel } from "../../src/view/labels.ts"
import type { StepView, ToolStep } from "../../src/view/turns.ts"

function tool(partial: Partial<ToolStep> & { id: string; name: string }): ToolStep {
  return { kind: "tool", status: "done", args: "{}", startedAt: 0, ...partial }
}

describe("stepLabel", () => {
  it("reads a denied step as Denied x, or the server's label, and never runs an override", () => {
    const denied = tool({ id: "1", name: "searchCorpus", status: "denied", args: '{"query":"a"}' })
    expect(stepLabel(denied)).toBe("Denied searchCorpus")
    expect(stepLabel(denied, { searchCorpus: { done: () => "Searched" } })).toBe(
      "Denied searchCorpus",
    )
    expect(stepLabel({ ...denied, label: "Search was blocked" })).toBe("Search was blocked")
  })

  it("prefers the override, then the server label, then the fallback", () => {
    expect(stepLabel(tool({ id: "1", name: "searchCorpus", label: "Searched the corpus" }))).toBe(
      "Searched the corpus",
    )
    expect(
      stepLabel(
        tool({ id: "1", name: "readFile", label: "Read notes.md", args: '{"path":"notes.md"}' }),
        {
          readFile: { done: (args) => `Leyó ${(args as { path: string }).path}` },
        },
      ),
    ).toBe("Leyó notes.md")
    expect(
      stepLabel(tool({ id: "1", name: "readFile", label: "Read notes.md" }), {
        readFile: { done: () => "" },
      }),
    ).toBe("Read notes.md")
    expect(
      stepLabel(tool({ id: "1", name: "searchCorpus", args: '{"query":"a"}' }), {
        searchCorpus: { done: (args) => `Looked for ${(args as { query: string }).query}` },
      }),
    ).toBe("Looked for a")
    expect(stepLabel(tool({ id: "1", name: "searchCorpus", status: "running" }))).toBe(
      "Using searchCorpus…",
    )
    expect(stepLabel(tool({ id: "1", name: "searchCorpus" }))).toBe("Used searchCorpus")
  })

  it("picks the running or done override by status and hands done the result", () => {
    const overrides = {
      x: {
        running: () => "Looking",
        done: (_args: unknown, result: string | undefined) => `Found ${result}`,
      },
    }
    expect(stepLabel(tool({ id: "1", name: "x", status: "pending" }), overrides)).toBe("Looking")
    expect(stepLabel(tool({ id: "1", name: "x", status: "awaiting" }), overrides)).toBe("Looking")
    expect(stepLabel(tool({ id: "1", name: "x", result: "3 hits" }), overrides)).toBe(
      "Found 3 hits",
    )
    expect(
      stepLabel(tool({ id: "1", name: "x", status: "failed", result: "boom" }), overrides),
    ).toBe("Found boom")
  })

  it("falls back when the override for that status is missing or returns nothing", () => {
    expect(
      stepLabel(tool({ id: "1", name: "x", status: "running" }), { x: { done: () => "Done" } }),
    ).toBe("Using x…")
    expect(stepLabel(tool({ id: "1", name: "x" }), { x: { done: () => "" } })).toBe("Used x")
    expect(
      stepLabel(tool({ id: "1", name: "x" }), { x: { done: () => 42 as unknown as string } }),
    ).toBe("Used x")
  })

  it("never throws when an override does, and never claims unknown args", () => {
    expect(
      stepLabel(tool({ id: "1", name: "x", args: "not json" }), {
        x: {
          done: () => {
            throw new Error("boom")
          },
        },
      }),
    ).toBe("Used x")
    let seen: unknown = "unset"
    stepLabel(tool({ id: "1", name: "x", args: "not json" }), {
      x: {
        done: (args) => {
          seen = args
          return "ok"
        },
      },
    })
    expect(seen).toBeUndefined()
  })

  it("treats an empty server label as absent", () => {
    expect(stepLabel(tool({ id: "1", name: "x", label: "" }))).toBe("Used x")
    expect(stepLabel(tool({ id: "1", name: "x", label: "" }), { x: { done: () => "Did x" } })).toBe(
      "Did x",
    )
  })

  it("looks overrides up by own key only", () => {
    expect(stepLabel(tool({ id: "1", name: "toString" }))).toBe("Used toString")
    expect(stepLabel(tool({ id: "1", name: "constructor", status: "running" }))).toBe(
      "Using constructor…",
    )
    expect(
      stepLabel(tool({ id: "1", name: "hasOwnProperty" }), { other: { done: () => "no" } }),
    ).toBe("Used hasOwnProperty")
  })

  it("cuts at 120 code points without splitting a surrogate pair", () => {
    const emoji = "😀".repeat(130)
    const cut = stepLabel(tool({ id: "1", name: "x", label: emoji }))
    expect([...cut]).toHaveLength(120)
    expect(cut).toBe(`${"😀".repeat(119)}…`)
    expect(cut).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
  })

  it("cuts a label longer than 120 characters with an ellipsis", () => {
    const long = "x".repeat(200)
    expect(stepLabel(tool({ id: "1", name: "x", label: long }))).toBe(`${"x".repeat(119)}…`)
    expect(stepLabel(tool({ id: "1", name: "x" }), { x: { done: () => long } })).toBe(
      `${"x".repeat(119)}…`,
    )
    expect(stepLabel(tool({ id: "1", name: "x", label: "x".repeat(120) }))).toBe("x".repeat(120))
  })
})

describe("groupSteps", () => {
  it("merges consecutive done calls of the same tool, two or more, with a built-in or fallback label", () => {
    const steps: StepView[] = [
      tool({ id: "1", name: "readFile" }),
      tool({ id: "2", name: "readFile" }),
      tool({ id: "3", name: "searchCorpus" }),
      tool({ id: "4", name: "runBash" }),
      tool({ id: "5", name: "runBash" }),
      tool({ id: "6", name: "runBash" }),
      tool({ id: "7", name: "searchCorpus", status: "running" }),
      tool({ id: "8", name: "searchCorpus", status: "running" }),
    ]
    const grouped = groupSteps(steps)
    expect(
      grouped.map((g) => (g.kind === "group" ? `${g.name}×${g.steps.length}:${g.label}` : g.kind)),
    ).toEqual(["readFile×2:Read 2 files", "tool", "runBash×3:Ran 3 commands", "tool", "tool"])
    expect(BUILT_IN_GROUP_LABELS.searchCorpus).toBeUndefined()
    expect(
      groupSteps([tool({ id: "a", name: "zap" }), tool({ id: "b", name: "zap" })])[0],
    ).toMatchObject({
      kind: "group",
      label: "Used zap 2 times",
    })
  })

  it("never groups task or writeTodos, and lets an override name the group", () => {
    const steps: StepView[] = [tool({ id: "1", name: "task" }), tool({ id: "2", name: "task" })]
    expect(groupSteps(steps).map((g) => g.kind)).toEqual(["tool", "tool"])
    const todos: StepView[] = [
      tool({ id: "1", name: "writeTodos" }),
      tool({ id: "2", name: "writeTodos" }),
    ]
    expect(groupSteps(todos).map((g) => g.kind)).toEqual(["tool", "tool"])
    const two: StepView[] = [
      tool({ id: "1", name: "searchCorpus" }),
      tool({ id: "2", name: "searchCorpus" }),
    ]
    expect(
      groupSteps(two, { searchCorpus: { group: (n) => `Searched the corpus ${n} times` } })[0],
    ).toMatchObject({
      label: "Searched the corpus 2 times",
    })
  })

  it("falls back when a group override throws or returns nothing", () => {
    const two = (name: string): StepView[] => [tool({ id: "1", name }), tool({ id: "2", name })]
    const boom = () => {
      throw new Error("boom")
    }
    expect(groupSteps(two("readFile"), { readFile: { group: boom } })[0]).toMatchObject({
      label: "Read 2 files",
    })
    expect(groupSteps(two("zap"), { zap: { group: boom } })[0]).toMatchObject({
      label: "Used zap 2 times",
    })
    expect(groupSteps(two("zap"), { zap: { group: () => "" } })[0]).toMatchObject({
      label: "Used zap 2 times",
    })
    expect(
      groupSteps(two("readFile"), { readFile: { group: () => 42 as unknown as string } })[0],
    ).toMatchObject({
      label: "Read 2 files",
    })
  })

  it("never reaches prototype keys through a tool name", () => {
    expect(
      groupSteps([tool({ id: "1", name: "toString" }), tool({ id: "2", name: "toString" })])[0],
    ).toMatchObject({
      kind: "group",
      label: "Used toString 2 times",
    })
    expect(
      groupSteps([
        tool({ id: "1", name: "constructor" }),
        tool({ id: "2", name: "constructor" }),
      ])[0],
    ).toMatchObject({ kind: "group", label: "Used constructor 2 times" })
  })

  it.each([
    ["readFile", "Read 2 files"],
    ["writeFile", "Saved 2 files"],
    ["editFile", "Edited 2 files"],
    ["listDir", "Listed 2 directories"],
    ["runBash", "Ran 2 commands"],
    ["recall", "Checked memory 2 times"],
    ["remember", "Remembered 2 things"],
    ["readSkill", "Loaded 2 skills"],
  ])("labels two %s calls as %s", (name, label) => {
    expect(Object.keys(BUILT_IN_GROUP_LABELS)).toHaveLength(8)
    expect(groupSteps([tool({ id: "1", name }), tool({ id: "2", name })])[0]).toMatchObject({
      kind: "group",
      label,
    })
  })

  it("breaks a run on a failed or awaiting step and on any non-tool step", () => {
    const plan: StepView = { kind: "plan", id: "p", todos: [], startedAt: 0, updatedAt: 0 }
    const steps: StepView[] = [
      tool({ id: "1", name: "readFile" }),
      tool({ id: "2", name: "readFile", status: "failed" }),
      tool({ id: "3", name: "readFile" }),
      plan,
      tool({ id: "4", name: "readFile" }),
      tool({ id: "5", name: "readFile", status: "awaiting" }),
    ]
    expect(groupSteps(steps).map((g) => g.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "plan",
      "tool",
      "tool",
    ])
  })

  it("returns ungrouped steps as the same objects and an empty list unchanged", () => {
    const only = tool({ id: "1", name: "readFile" })
    const plan: StepView = { kind: "plan", id: "p", todos: [], startedAt: 0, updatedAt: 0 }
    const grouped = groupSteps([only, plan])
    expect(grouped[0]).toBe(only)
    expect(grouped[1]).toBe(plan)
    expect(groupSteps([])).toEqual([])
    const a = tool({ id: "a", name: "readFile" })
    const b = tool({ id: "b", name: "readFile" })
    const group = groupSteps([a, b])[0]
    expect(group?.kind === "group" && group.steps[0] === a && group.steps[1] === b).toBe(true)
  })
})
