// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { TurnActivity } from "../../src/react/index.js"
import type { TurnView } from "../../src/view/turns.js"

const nested: TurnView = {
  runId: "c1",
  status: "done",
  startedAt: 1000,
  endedAt: 9000,
  text: "ReAct interleaves…",
  approvals: [],
  failed: 0,
  steps: [
    {
      kind: "tool",
      id: "n1",
      name: "readDoc",
      status: "done",
      args: '{"path":"a.md"}',
      result: "…",
      label: "Read a.md",
      icon: "read",
      startedAt: 1000,
      settledAt: 2000,
    },
    {
      kind: "tool",
      id: "n2",
      name: "runBash",
      status: "done",
      args: '{"command":"node x"}',
      result: "ok",
      label: "Ran node x",
      icon: "run",
      startedAt: 2000,
      settledAt: 8000,
    },
  ],
}
const turn: TurnView = {
  runId: "r1",
  status: "done",
  startedAt: 0,
  endedAt: 72_000,
  text: "",
  approvals: [],
  failed: 0,
  steps: [
    { kind: "reasoning", id: "th", text: "plan it", status: "done", startedAt: 0, settledAt: 4000 },
    {
      kind: "plan",
      id: "plan",
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
      ],
      startedAt: 0,
      updatedAt: 1,
    },
    {
      kind: "tool",
      id: "s1",
      name: "searchCorpus",
      status: "done",
      args: "{}",
      label: "Searched the corpus",
      icon: "search",
      startedAt: 10,
      settledAt: 20,
      sources: [{ title: "a.md" }],
    },
    {
      kind: "tool",
      id: "s2",
      name: "searchCorpus",
      status: "done",
      args: "{}",
      label: "Searched the corpus",
      icon: "search",
      startedAt: 20,
      settledAt: 30,
      sources: [{ title: "b.md" }],
    },
    {
      kind: "subagent",
      id: "c1",
      name: "researcher",
      description: "summarize ReAct",
      status: "done",
      startedAt: 1000,
      settledAt: 9000,
      turn: nested,
    },
    {
      kind: "tool",
      id: "w",
      name: "writeFile",
      status: "done",
      args: '{"path":"reports/x.md"}',
      label: "Saved reports/x.md",
      icon: "write",
      startedAt: 9000,
      settledAt: 9500,
    },
  ],
}

describe("kit smoke", () => {
  test("a settled research turn renders folded with the right summary, and open with every row kind", () => {
    const folded = renderToStaticMarkup(<TurnActivity turn={turn} now={() => 0} />)
    expect(folded).toContain("Worked for 1m 12s")
    expect(folded).toContain("· 8 steps · 2 sources")
    expect(folded).not.toContain("b4-turn__steps")
  })

  test("clicking the summary opens one row per top-level step, nested rows staying folded", () => {
    render(<TurnActivity turn={turn} now={() => 0} />)
    fireEvent.click(screen.getByRole("button", { name: /Worked for 1m 12s/ }))
    const kinds = screen
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-kind"))
      .filter(Boolean)
    expect(kinds).toEqual(["reasoning", "plan", "group", "subagent", "tool"])
  })
})
