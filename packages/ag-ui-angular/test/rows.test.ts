import { ChangeDetectionStrategy, Component, signal, type Type } from "@angular/core"
import type {
  PlanStep,
  ReasoningStep,
  StepGroup,
  SubagentStep,
  ToolStep,
  TurnView,
} from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import {
  plan,
  reasoning,
  subagent,
  tool,
  turn,
} from "../../ag-ui/test/fixtures/activity-fixtures.ts"
import { ChecklistComponent } from "../src/lib/checklist.component"
import { PlanStepComponent } from "../src/lib/plan-step.component"
import { ReasoningStepComponent } from "../src/lib/reasoning-step.component"
import { StepGroupComponent } from "../src/lib/step-group.component"
import { SubagentStepComponent } from "../src/lib/subagent-step.component"
import { click, mount } from "./render"

const zero = () => 0
/** innerHTML without the comment anchors Angular leaves for control flow. */
const markup = (element: Element | null) => element?.innerHTML.replace(/<!--[\s\S]*?-->/g, "")
const thousand = () => 1000

@Component({
  imports: [StepGroupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol><li b4-step-group [group]="group()" [now]="now"></li></ol>`,
})
class GroupHost {
  readonly group = signal<StepGroup>({ kind: "group", name: "x", label: "x", steps: [] })
  readonly now = thousand
}

@Component({
  imports: [PlanStepComponent, ChecklistComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol><li b4-plan-step [step]="step()" [live]="live()"></li></ol><b4-checklist [todos]="step().todos" />`,
})
class PlanHost {
  readonly step = signal<PlanStep>(plan())
  readonly live = signal(false)
}

@Component({
  imports: [ReasoningStepComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol><li b4-reasoning-step [step]="step()"></li></ol>`,
})
class ReasoningHost {
  readonly step = signal<ReasoningStep>(reasoning())
}

@Component({
  imports: [SubagentStepComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol><li b4-subagent-step [step]="step()" [now]="now()"></li></ol>`,
})
class SubagentHost {
  readonly step = signal<SubagentStep>(subagent())
  readonly now = signal(zero)
}

function host<T>(component: Type<T>, set: (instance: T) => void) {
  const fixture = mount(component, {})
  set(fixture.componentInstance)
  fixture.detectChanges()
  const root = fixture.nativeElement as HTMLElement
  const row = () => root.querySelector("ol > li.b4-step") as HTMLElement
  return { fixture, root, row }
}

const searchTool = (id: string, o: Partial<ToolStep> = {}): ToolStep =>
  tool(id, { args: `{"q":"${id}"}`, settledAt: 10, label: undefined, ...o })
const group: StepGroup = {
  kind: "group",
  name: "searchCorpus",
  label: "Searched the corpus 2 times",
  steps: [searchTool("a", { sources: [{ title: "a.md" }] }), searchTool("b")],
}

describe("li[b4-step-group]", () => {
  test("renders one closed row with the merged label and the sources count", () => {
    const { root, row } = host(GroupHost, (h) => h.group.set(group))
    expect(row().getAttribute("data-state")).toBe("done")
    expect(row().getAttribute("data-kind")).toBe("group")
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("Searched the corpus 2 times")
    expect(root.querySelector(".b4-step__meta")?.textContent).toBe("· 1 source")
    expect(root.querySelector(".b4-step__children")).toBeNull()
  })

  test("opens to the individual steps", () => {
    const { fixture, root } = host(GroupHost, (h) => h.group.set(group))
    click(fixture, root.querySelector("button"))
    expect(root.querySelectorAll("li").length).toBe(1 + 2 + 1) // group row, two steps, one chip
    const texts = Array.from(root.querySelectorAll(".b4-step__children .b4-step__text"))
    expect(texts.map((t) => t.textContent)).toEqual(["Used searchCorpus", "Used searchCorpus"])
  })
})

const todos: PlanStep["todos"] = [
  { content: "Restate the question", status: "completed" },
  { content: "Search the corpus", status: "in_progress" },
  { content: "Write the comparison", status: "pending" },
]

describe("li[b4-plan-step] and b4-checklist", () => {
  test("reads Made a plan · 1 of 3 done, open while the turn is live, with an SVG checklist", () => {
    const { row } = host(PlanHost, (h) => {
      h.step.set(plan({ todos }))
      h.live.set(true)
    })
    expect(row().getAttribute("data-state")).toBe("running")
    expect(row().getAttribute("data-kind")).toBe("plan")
    expect(row().getAttribute("data-expanded")).toBe("true")
    expect(row().querySelector(".b4-step__text")?.textContent).toBe("Made a plan")
    expect(row().querySelector(".b4-step__meta")?.textContent).toBe("· 1 of 3 done")
    const list = row().querySelector("ol.b4-checklist")
    expect(list?.getAttribute("aria-label")).toBe("Plan")
    const statuses = Array.from(list?.querySelectorAll(".b4-checklist__item") ?? [], (li) =>
      li.getAttribute("data-status"),
    )
    expect(statuses).toEqual(["completed", "in_progress", "pending"])
    expect(list?.querySelector("svg.b4-checklist__box rect")?.getAttribute("fill")).toBe(
      "currentColor",
    )
    expect(list?.textContent).toContain("Search the corpus (in progress)")
  })

  test("settles when the turn ends: done state, closed by default; reopens when live again", () => {
    const { fixture, row } = host(PlanHost, (h) => {
      h.step.set(plan({ todos: todos.map((t) => ({ ...t, status: "completed" as const })) }))
    })
    expect(row().getAttribute("data-state")).toBe("done")
    expect(row().querySelector(".b4-step__meta")?.textContent).toBe("· 3 of 3 done")
    expect(row().querySelector(".b4-checklist")).toBeNull()
    fixture.componentInstance.live.set(true)
    fixture.detectChanges()
    expect(row().getAttribute("data-expanded")).toBe("true")
  })

  test("b4-checklist is exported for custom steps", () => {
    const { root } = host(PlanHost, (h) => h.step.set(plan({ todos })))
    const standalone = root.querySelector(":scope > b4-checklist ol.b4-checklist")
    expect(standalone?.querySelectorAll('[data-status="pending"]').length).toBe(1)
  })
})

describe("li[b4-reasoning-step]", () => {
  test("streaming reads Thinking…, is running and open", () => {
    const { root, row } = host(ReasoningHost, (h) =>
      h.step.set(reasoning({ status: "streaming", settledAt: undefined, text: "Let me think" })),
    )
    expect(row().getAttribute("data-state")).toBe("running")
    expect(row().getAttribute("data-expanded")).toBe("true")
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("Thinking…")
    expect(root.querySelector(".b4-step__detail > p.b4-step__reasoning")?.textContent).toBe(
      "Let me think",
    )
  })

  test("done reads Thought for 4s and is closed; a click opens the text", () => {
    const { fixture, root, row } = host(ReasoningHost, (h) => h.step.set(reasoning()))
    expect(row().getAttribute("data-state")).toBe("done")
    expect(row().getAttribute("data-expanded")).toBeNull()
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("Thought for 4s")
    expect(root.querySelector(".b4-step__detail")).toBeNull()
    click(fixture, root.querySelector("button"))
    expect(root.querySelector(".b4-step__reasoning")).not.toBeNull()
  })

  test("encrypted (done with no text) is not openable", () => {
    const { root, row } = host(ReasoningHost, (h) => h.step.set(reasoning({ text: "" })))
    expect(root.querySelector("span.b4-step__line.b4-step__line--static")).not.toBeNull()
    expect(root.querySelector("button")).toBeNull()
    expect(row().getAttribute("data-expanded")).toBeNull()
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("Thought for 4s")
  })
})

const nested = (status: TurnView["status"]): TurnView =>
  turn({
    runId: "c",
    status,
    endedAt: status === "working" || status === "awaiting" ? undefined : 9000,
    steps: [
      tool("n1", { name: "readDoc", label: "Read a.md", settledAt: 5 }),
      tool("n2", { name: "readDoc", label: "Read a.md", settledAt: 5 }),
    ],
  })

describe("li[b4-subagent-step]", () => {
  test("running reads Asked researcher with the description beneath, is open, and nests the child's activity", () => {
    const { root, row } = host(SubagentHost, (h) => {
      h.step.set(
        subagent({
          status: "running",
          settledAt: undefined,
          description: "summarize ReAct",
          turn: nested("working"),
        }),
      )
      h.now.set(thousand)
    })
    expect(row().getAttribute("data-state")).toBe("running")
    expect(row().getAttribute("data-expanded")).toBe("true")
    const text = root.querySelector(".b4-step__text")
    expect(markup(text)).toBe(
      'Asked <b>researcher</b><span class="b4-step__note">summarize ReAct</span>',
    )
    const nestedTurn = root.querySelector(".b4-step__children section.b4-turn")
    expect(nestedTurn?.getAttribute("data-state")).toBe("working")
  })

  test("a running subagent without a description reads Asked researcher and nothing more", () => {
    const { root } = host(SubagentHost, (h) =>
      h.step.set(
        subagent({
          status: "running",
          settledAt: undefined,
          description: undefined,
          turn: nested("working"),
        }),
      ),
    )
    expect(markup(root.querySelector(".b4-step__text"))).toBe("Asked <b>researcher</b>")
    expect(root.querySelector(".b4-step__note")).toBeNull()
  })

  test("paused maps to awaiting; done folds to researcher finished · N steps", () => {
    const paused = host(SubagentHost, (h) =>
      h.step.set(subagent({ status: "paused", settledAt: undefined, turn: nested("awaiting") })),
    )
    expect(paused.row().getAttribute("data-state")).toBe("awaiting")
    const done = host(SubagentHost, (h) => h.step.set(subagent({ turn: nested("done") })))
    expect(done.row().getAttribute("data-state")).toBe("done")
    expect(done.row().getAttribute("data-expanded")).toBeNull()
    expect(done.root.querySelector(".b4-step__text")?.textContent).toBe("researcher finished")
    expect(done.root.querySelector(".b4-step__meta")?.textContent).toBe("· 2 steps")
    expect(done.root.querySelector(".b4-step__children")).toBeNull()
  })

  test("failed reads researcher failed with the error, open", () => {
    const { root, row } = host(SubagentHost, (h) =>
      h.step.set(subagent({ status: "failed", error: "boom", turn: nested("failed") })),
    )
    expect(row().getAttribute("data-state")).toBe("failed")
    expect(row().getAttribute("data-expanded")).toBe("true")
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("researcher failed")
    expect(root.querySelector(".b4-step__meta")?.textContent).toBe("· boom")
  })
})
