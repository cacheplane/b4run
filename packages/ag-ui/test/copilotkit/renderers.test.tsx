import { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE } from "../../src/activities.js"
import { b4ActivityRenderers } from "../../src/copilotkit/renderers.js"
import { ActivityChecklist } from "../../src/react/ActivityChecklist.js"
import { PlanActivityCard } from "../../src/react/PlanActivityCard.js"
import { planActivityContentSchema } from "../../src/react/schemas.js"

describe("plan schema", () => {
  it("accepts a valid plan activity", () => {
    expect(
      planActivityContentSchema.safeParse({
        todos: [
          { content: "Search the corpus", status: "in_progress" },
          { content: "Write the report", status: "pending" },
        ],
      }).success,
    ).toBe(true)
  })

  it("rejects extra keys", () => {
    expect(
      planActivityContentSchema.safeParse({
        todos: [{ content: "Search the corpus", status: "completed" }],
        id: "runtime-plan-id",
      }).success,
    ).toBe(false)
  })
})

function visibleText(markup: string): string {
  return Array.from(markup.matchAll(/>([^<]*)/g), (match) => match[1] ?? "").join("")
}

describe("plan activity card", () => {
  it("expands an active plan and shows progress with visible status labels", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{
          todos: [
            { content: "Collect sources", status: "pending" },
            { content: "Analyze evidence", status: "in_progress" },
            { content: "Write report", status: "completed" },
          ],
        }}
      />,
    )

    expect(markup).toContain("<details open")
    expect(visibleText(markup)).toContain("Plan · 1/3 complete")
    expect(markup).toContain("pending")
    expect(markup).toContain("in progress")
    expect(markup).toContain("completed")
  })

  it("shows at most eight todos and reports the overflow", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{
          todos: Array.from({ length: 10 }, (_, index) => ({
            content: `Step ${index + 1}`,
            status: "pending" as const,
          })),
        }}
      />,
    )

    expect(markup.match(/<li/g)).toHaveLength(8)
    expect(markup).toContain("+2 more")
  })

  it("collapses a plan with no active todo", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{ todos: [{ content: "Collect sources", status: "completed" }] }}
      />,
    )

    expect(markup).not.toContain("<details open")
  })
})

function descendantElements(element: ReactElement): ReactElement[] {
  const { children } = element.props as { children?: ReactNode }
  const childNodes = Array.isArray(children) ? children : [children]
  return childNodes.flatMap((child) =>
    isValidElement(child) ? [child, ...descendantElements(child)] : [],
  )
}

describe("activity card quality boundaries", () => {
  it("assigns unique identifier-free keys to duplicate todo content", () => {
    const checklist = ActivityChecklist({
      todos: [
        { content: "Review evidence", status: "pending" },
        { content: "Review evidence", status: "in_progress" },
      ],
    })
    const itemKeys = descendantElements(checklist)
      .filter((element) => element.type === "li")
      .map((element) => element.key)

    expect(new Set(itemKeys).size).toBe(itemKeys.length)
  })

  it("protects long unbroken plan content from overflowing", () => {
    const longContent = "evidence".repeat(60)
    const markup = renderToStaticMarkup(
      <PlanActivityCard content={{ todos: [{ content: longContent, status: "in_progress" }] }} />,
    )

    expect(markup).toContain(longContent)
    expect(markup.match(/b4-activity__item-label/g)).toHaveLength(1)
  })

  it("retains explicit list semantics for the markerless checklist", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard content={{ todos: [{ content: "Review evidence", status: "pending" }] }} />,
    )

    expect(markup).toMatch(/<ol[^>]*role="list"/)
  })
})

describe("activity renderer registry", () => {
  it("registers the public activity types in order", () => {
    expect(b4ActivityRenderers.map((renderer) => renderer.activityType)).toEqual([
      B4_PLAN_ACTIVITY_TYPE,
    ])
  })

  it("synchronously validates representative content through each renderer", () => {
    const representativeContent = [
      { todos: [{ content: "Write the report", status: "pending" }] },
    ] as const

    b4ActivityRenderers.forEach((renderer, index) => {
      const result = renderer.content["~standard"].validate(representativeContent[index])
      expect(result).not.toBeInstanceOf(Promise)
      if (result instanceof Promise) throw new Error("activity validation must be synchronous")
      expect("value" in result).toBe(true)
    })
  })
})
