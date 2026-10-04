import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Checklist, PlanStep } from "../../src/react/activity/PlanStep.js"
import type { PlanStep as PlanStepView } from "../../src/view/turns.js"

const plan = (todos: PlanStepView["todos"]): PlanStepView => ({
  kind: "plan",
  id: "p",
  todos,
  startedAt: 0,
  updatedAt: 0,
})
const todos: PlanStepView["todos"] = [
  { content: "Restate the question", status: "completed" },
  { content: "Search the corpus", status: "in_progress" },
  { content: "Write the comparison", status: "pending" },
]

describe("PlanStep", () => {
  test("reads Made a plan · 1 of 3 done, open while the turn is live, with an SVG checklist", () => {
    const markup = renderToStaticMarkup(<PlanStep step={plan(todos)} live={true} />)
    expect(markup).toContain(
      '<li class="b4-step" data-state="running" data-kind="plan" data-expanded="true">',
    )
    expect(markup).toContain(
      '<span class="b4-step__text">Made a plan</span><span class="b4-step__meta">· 1 of 3 done</span>',
    )
    expect(markup).toContain('<ol class="b4-checklist" aria-label="Plan">')
    expect(markup).toContain('<li class="b4-checklist__item" data-status="completed">')
    expect(markup).toContain('<li class="b4-checklist__item" data-status="in_progress">')
    expect(markup).toContain("Search the corpus")
  })
  test("settles when the turn ends: done state, closed by default", () => {
    const markup = renderToStaticMarkup(
      <PlanStep step={plan(todos.map((t) => ({ ...t, status: "completed" })))} live={false} />,
    )
    expect(markup).toContain('data-state="done" data-kind="plan">')
    expect(markup).toContain("· 3 of 3 done")
    expect(markup).not.toContain("b4-checklist")
  })
  test("Checklist is exported for custom steps", () => {
    expect(renderToStaticMarkup(<Checklist todos={todos} />)).toContain('data-status="pending"')
  })
})
