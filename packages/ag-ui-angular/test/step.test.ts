import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core"
import type { StepLabelOverrides, ToolStep } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import { tool as baseTool, type Loose } from "../../ag-ui/test/fixtures/activity-fixtures.ts"
import { StepComponent, type StepRenderers } from "../src/lib/step.component"
import { click, mount } from "./render"

const tool = (o: Loose<ToolStep> & { id: string; name: string }): ToolStep =>
  baseTool(o.id, {
    args: '{"query":"a"}',
    settledAt: 1000,
    label: undefined,
    icon: undefined,
    ...o,
  })
const now = () => 10_000

@Component({
  imports: [StepComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol><li b4-step [step]="step()" [labels]="labels()" [renderStep]="renderStep()" [now]="now"></li></ol>`,
})
class StepHost {
  readonly step = signal<ToolStep>(tool({ id: "a", name: "x" }))
  readonly labels = signal<StepLabelOverrides | undefined>(undefined)
  readonly renderStep = signal<StepRenderers | undefined>(undefined)
  readonly now = now
}

function render(step: ToolStep, extra: { labels?: StepLabelOverrides } = {}) {
  const fixture = mount(StepHost, {})
  fixture.componentInstance.step.set(step)
  if (extra.labels) fixture.componentInstance.labels.set(extra.labels)
  fixture.detectChanges()
  const root = fixture.nativeElement as HTMLElement
  const li = () => root.querySelector("li.b4-step") as HTMLElement
  return { fixture, root, li }
}

@Component({
  selector: "test-table",
  template: `<table data-testid="t">{{ step().result }}</table>`,
})
class TableView {
  readonly step = input.required<ToolStep>()
}

describe("li[b4-step]", () => {
  test("renders the DOM contract with the server label and sources, closed by default", () => {
    const { root, li } = render(
      tool({
        id: "a",
        name: "searchCorpus",
        icon: "search",
        label: "Searched the corpus",
        sources: [{ title: "a.md" }],
      }),
    )
    expect(li().getAttribute("data-state")).toBe("done")
    expect(li().getAttribute("data-kind")).toBe("tool")
    expect(li().parentElement?.tagName).toBe("OL") // the host is the contract's own li
    const button = li().querySelector(":scope > button.b4-step__line")
    expect(button?.getAttribute("aria-expanded")).toBe("false")
    expect(root.querySelector(".b4-step__text")?.textContent).toBe("Searched the corpus")
    expect(root.querySelector(".b4-step__sources")).not.toBeNull()
    expect(root.querySelector(".b4-step__detail")).toBeNull()
  })

  test("falls back to Used x / an override, and a running step reads as pending for 300 ms", () => {
    expect(render(tool({ id: "a", name: "x" })).root.textContent).toContain("Used x")
    expect(
      render(tool({ id: "a", name: "x" }), { labels: { x: { done: () => "Did x" } } }).root
        .textContent,
    ).toContain("Did x")
    const fresh = render(
      tool({ id: "a", name: "x", status: "running", startedAt: 9_900, settledAt: undefined }),
    )
    expect(fresh.li().getAttribute("data-state")).toBe("pending")
    const old = render(
      tool({ id: "a", name: "x", status: "running", startedAt: 0, settledAt: undefined }),
    )
    expect(old.li().getAttribute("data-state")).toBe("running")
  })

  test("a denied step reads Denied x with its own icon, a denied meta, and stays closed", () => {
    const glyph = (r: HTMLElement) => r.querySelector(".b4-step__icon")?.innerHTML
    const denied = render(tool({ id: "a", name: "searchCorpus", status: "denied", icon: "search" }))
    expect(denied.li().getAttribute("data-state")).toBe("denied")
    expect(denied.li().getAttribute("data-expanded")).toBeNull()
    expect(denied.root.textContent).toContain("Denied searchCorpus")
    expect(denied.root.querySelector(".b4-step__meta")?.textContent).toBe("· denied")
    const failed = render(tool({ id: "a", name: "searchCorpus", status: "failed", icon: "search" }))
    const searching = render(tool({ id: "a", name: "searchCorpus", icon: "search" }))
    expect(glyph(denied.root)).toBe(glyph(searching.root))
    expect(glyph(denied.root)).not.toBe(glyph(failed.root))
  })

  test("awaiting and failed add meta; a failed step opens itself", () => {
    expect(
      render(tool({ id: "a", name: "x", status: "awaiting" })).root.querySelector(".b4-step__meta")
        ?.textContent,
    ).toBe("· awaiting approval")
    expect(
      render(tool({ id: "a", name: "x", status: "failed" })).root.querySelector(".b4-step__meta")
        ?.textContent,
    ).toBe("· failed")
    const failed = render(tool({ id: "a", name: "x", status: "failed", result: "ENOENT" }))
    expect(failed.li().getAttribute("data-expanded")).toBe("true")
    expect(failed.root.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
    expect(failed.root.textContent).toContain("ENOENT")
    expect(failed.root.querySelector(".b4-step__meta")).toBeNull()
  })

  test("clicking opens the detail; renderStep replaces it with an app component", () => {
    const { fixture, root, li } = render(tool({ id: "a", name: "x", result: "3 hits" }))
    expect(root.textContent).not.toContain("3 hits")
    click(fixture, root.querySelector("button"))
    expect(root.textContent).toContain("3 hits")
    expect(li().getAttribute("data-expanded")).toBe("true")
    fixture.componentInstance.renderStep.set({ x: TableView })
    fixture.detectChanges()
    expect(root.querySelector("[data-testid=t]")?.textContent).toBe("3 hits")
    expect(root.querySelector(".b4-step__detail")?.contains(root.querySelector("table"))).toBe(true)
    expect(root.textContent).not.toContain("Inputs")
  })

  test("renderStep is an own-key lookup: a tool named toString keeps the default detail", () => {
    const { fixture, root } = render(tool({ id: "a", name: "toString", result: "ok" }))
    fixture.componentInstance.renderStep.set({})
    fixture.detectChanges()
    click(fixture, root.querySelector("button"))
    const codes = Array.from(root.querySelectorAll(".b4-step__code"), (pre) => pre.textContent)
    expect(codes).toEqual(['{\n  "query": "a"\n}', "ok"])
  })

  test("a step opened while awaiting stays open when the same call starts running", () => {
    const awaiting = tool({ id: "a", name: "x", status: "awaiting", settledAt: undefined })
    const { fixture, root, li } = render(awaiting)
    click(fixture, root.querySelector("button"))
    expect(li().getAttribute("data-expanded")).toBe("true")
    fixture.componentInstance.step.set({ ...awaiting, status: "running" })
    fixture.detectChanges()
    expect(li().getAttribute("data-state")).toBe("running")
    expect(li().getAttribute("data-expanded")).toBe("true")
  })

  test("a call that restarts (new startedAt) while running hands the disclosure back to automation", () => {
    const running = tool({ id: "a", name: "x", status: "running", settledAt: undefined })
    const { fixture, root, li } = render(running)
    click(fixture, root.querySelector("button"))
    expect(li().getAttribute("data-expanded")).toBe("true")
    fixture.componentInstance.step.set({ ...running, startedAt: 5_000 })
    fixture.detectChanges()
    expect(li().getAttribute("data-state")).toBe("running")
    expect(li().getAttribute("data-expanded")).toBeNull()
  })
})
