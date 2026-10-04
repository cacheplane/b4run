// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { StepGroup } from "../../src/react/activity/StepGroup.js"
import type { StepGroup as Group } from "../../src/view/labels.js"
import type { ToolStep } from "../../src/view/turns.js"

const tool = (id: string, o: Partial<ToolStep> = {}): ToolStep => ({
  kind: "tool",
  id,
  name: "searchCorpus",
  status: "done",
  args: `{"q":"${id}"}`,
  startedAt: 0,
  settledAt: 10,
  icon: "search",
  ...o,
})
const group: Group = {
  kind: "group",
  name: "searchCorpus",
  label: "Searched the corpus 2 times",
  steps: [tool("a", { sources: [{ title: "a.md" }] }), tool("b")],
}
const now = () => 1000

describe("StepGroup", () => {
  test("renders one closed row with the merged label and the sources count", () => {
    const markup = renderToStaticMarkup(<StepGroup group={group} now={now} />)
    expect(markup).toContain('<li class="b4-step" data-state="done" data-kind="group">')
    expect(markup).toContain(
      '<span class="b4-step__text">Searched the corpus 2 times</span><span class="b4-step__meta">· 1 source</span>',
    )
    expect(markup).not.toContain("b4-step__children")
  })

  test("opens to the individual steps", () => {
    render(<StepGroup group={group} now={now} />)
    fireEvent.click(screen.getByRole("button", { name: /Searched the corpus 2 times/ }))
    const items = screen.getAllByRole("listitem")
    expect(items.length).toBe(1 + 2 + 1) // group row, two steps, one source chip
    expect(screen.getAllByText("Used searchCorpus")).toHaveLength(2)
  })
})
