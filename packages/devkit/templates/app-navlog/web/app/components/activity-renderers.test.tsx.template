import { B4_PLAN_ACTIVITY_TYPE } from "@b4run/ag-ui"
import { planActivityContentSchema } from "@b4run/ag-ui/react"
import type { ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { workbenchActivityRenderers } from "./activity-renderers"
import { PlanCard } from "./PlanCard"

const PLAN_CONTENT = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

/** Ten todos against the package's limit of 8 — the checklist bound. */
const PLAN_OVERFLOW_CONTENT = {
  todos: Array.from({ length: 10 }, (_, index) => ({
    content: `Step ${index + 1}`,
    status: "pending" as const,
  })),
}

describe("workbench plan card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("b4-activity tracking-tight")
    expect(markup).toContain("b4-activity__title font-medium")
    expect(markup).toContain("b4-activity__meta tabular-nums")
    expect(markup).toContain("b4-activity__item-glyph w-4 shrink-0 text-center")
    expect(markup).toContain("b4-activity__item-label leading-5")
  })

  test("still renders the package's content", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("Search the corpus")
    expect(markup).toContain("b4-activity__item--in_progress")
    expect(markup).toContain("1/2 complete")
  })

  test("keeps the package's checklist bound and styles the overflow node", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_OVERFLOW_CONTENT} />)
    expect(markup).toContain("Step 8")
    expect(markup).not.toContain("Step 9")
    expect(markup).toContain("b4-activity__overflow tabular-nums")
    expect(markup).toContain("+2 more")
  })
})

/**
 * The provider takes `ReactActivityMessageRenderer<any>[]`, which erases the
 * content type at that boundary: pairing the plan schema with another card
 * typechecks cleanly and simply renders nothing at runtime. These tests are the
 * only thing standing between that slip and a silent blank transcript.
 */
function renderEntry(entry: (typeof workbenchActivityRenderers)[number], content: unknown): string {
  // The provider passes `{ activityType, content, message, agent }`; both
  // wrappers read only `content`, so the omitted props are deliberate.
  const Renderer = entry.render as unknown as ComponentType<{ content: unknown }>
  return renderToStaticMarkup(<Renderer content={content} />)
}

describe("workbench activity renderer registry", () => {
  test("registers the package's one activity type", () => {
    expect(workbenchActivityRenderers.map((entry) => entry.activityType)).toEqual([
      B4_PLAN_ACTIVITY_TYPE,
    ])
  })

  test("pairs the plan activity with the package's schema", () => {
    const [plan] = workbenchActivityRenderers
    expect(plan?.content).toBe(planActivityContentSchema)
  })

  test("renders the workbench plan card for the entry", () => {
    const [plan] = workbenchActivityRenderers
    if (!plan) throw new Error("expected the plan renderer")

    const planMarkup = renderEntry(plan, PLAN_CONTENT)
    expect(planMarkup).toContain("b4-activity__title font-medium")
    expect(planMarkup).toContain("1/2 complete")
  })
})
