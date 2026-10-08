import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TurnActivityComponent } from "../../src/angular/lib/turn-activity.component.js"
import { TURN_FIXTURES, tool, turn } from "../fixtures/activity-fixtures.ts"
import { click, mount, update } from "./render.js"

const zero = () => 0
const html = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement

describe("b4-turn-activity", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("a working turn is open, shimmers the active label, ticks the time and announces once per label", () => {
    let clock = 12_400
    const working = turn({
      status: "working",
      endedAt: undefined,
      steps: [
        tool("a"),
        tool("b", {
          status: "running",
          settledAt: undefined,
          label: "Searching the corpus",
          startedAt: 100,
        }),
      ],
    })
    const fixture = mount(TurnActivityComponent, { turn: working, now: () => clock })
    const root = html(fixture)
    const section = root.querySelector("section.b4-turn") as HTMLElement
    expect(section.getAttribute("data-state")).toBe("working")
    expect(section.getAttribute("data-expanded")).toBe("true")
    const summary = section.querySelector(":scope > button.b4-turn__summary") as HTMLElement
    expect(summary.getAttribute("aria-expanded")).toBe("true")
    expect(summary.querySelector(".b4-turn__text")?.textContent).toBe("Searching the corpus")
    expect(summary.querySelector(".b4-turn__text")?.getAttribute("data-live")).toBe("true")
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 12s")
    const status = root.querySelector('[role="status"]') as HTMLElement
    expect(status.textContent).toBe("Searching the corpus")
    const observer = new MutationObserver(() => {})
    observer.observe(status, { childList: true, characterData: true, subtree: true })
    clock = 13_400
    vi.advanceTimersByTime(1000)
    fixture.detectChanges()
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 13s")
    expect(status.textContent).toBe("Searching the corpus")
    expect(observer.takeRecords()).toHaveLength(0) // the tick never touches the live region
    observer.disconnect()
    // One done call and one running call: nothing merges while a call is live.
    expect(section.querySelectorAll(":scope > ol > li")).toHaveLength(2)
  })

  test("a settled turn starts folded with the Worked for summary; clicking opens the steps", () => {
    const fixture = mount(TurnActivityComponent, {
      turn: turn({ steps: [tool("a"), tool("b", { name: "readDoc", label: "Read a.md" })] }),
      now: zero,
    })
    const root = html(fixture)
    const section = root.querySelector("section.b4-turn") as HTMLElement
    expect(section.getAttribute("data-state")).toBe("done")
    expect(section.getAttribute("data-expanded")).toBeNull()
    expect(root.querySelector(".b4-turn__text")?.textContent).toBe("Worked for 1m 12s")
    expect(root.querySelector(".b4-turn__text")?.hasAttribute("data-live")).toBe(false)
    expect(root.querySelector(".b4-turn__time")?.textContent).toBe("· 2 steps")
    expect(root.querySelector(".b4-turn__steps")).toBeNull()
    click(fixture, root.querySelector("button"))
    expect(root.querySelector("section > ol.b4-turn__steps")).not.toBeNull()
  })

  test("a live turn that settles folds; a failed step keeps the turn state failed and opens the step", () => {
    const fixture = mount(TurnActivityComponent, {
      turn: turn({ status: "working", endedAt: undefined }),
      now: () => 1000,
    })
    const root = html(fixture)
    const section = () => root.querySelector("section.b4-turn") as HTMLElement
    expect(section().getAttribute("data-expanded")).toBe("true")
    update(fixture, {
      turn: turn({
        status: "failed",
        failed: 1,
        steps: [tool("a", { status: "failed", result: "ENOENT", label: "Couldn't read plan.md" })],
      }),
      now: () => 2000,
    })
    expect(section().getAttribute("data-state")).toBe("failed")
    expect(section().getAttribute("data-expanded")).toBeNull()
    click(fixture, root.querySelector("button.b4-turn__summary"))
    const row = root.querySelector("li.b4-step") as HTMLElement
    expect(row.textContent).toContain("Couldn't read plan.md")
    expect(row.getAttribute("data-expanded")).toBe("true")
    expect(root.querySelector(".b4-turn__time")?.textContent).toBe("· 1 step · 1 failed")
  })

  test("awaiting turns read Waiting for your approval and stay open", () => {
    const fixture = mount(TurnActivityComponent, {
      turn: turn({
        status: "awaiting",
        endedAt: undefined,
        steps: [tool("a", { status: "awaiting", label: "Wants to run a command" })],
      }),
      now: () => 38_000,
    })
    const root = html(fixture)
    expect(root.querySelector("section")?.getAttribute("data-expanded")).toBe("true")
    expect(root.querySelector(".b4-turn__text")?.textContent).toBe("Waiting for your approval")
    expect(root.textContent).toContain("· awaiting approval")
  })

  test("nested turns name the subagent", () => {
    const done = html(
      mount(TurnActivityComponent, {
        turn: turn({}),
        now: zero,
        nested: { name: "researcher", status: "done" },
      }),
    )
    expect(done.querySelector(".b4-turn__text")?.textContent).toBe("researcher finished")
    expect(done.querySelector(".b4-turn__time")?.textContent).toBe("· 2 steps")
    const paused = html(
      mount(TurnActivityComponent, {
        turn: turn({ status: "awaiting", endedAt: undefined }),
        now: zero,
        nested: { name: "researcher", status: "paused" },
      }),
    )
    expect(paused.querySelector(".b4-turn__text")?.textContent).toBe("researcher · paused")
  })

  test("a running nested turn reads like any turn: the active step's label shimmers and the time ticks", () => {
    const fixture = TURN_FIXTURES["nested turn, running"]
    if (!fixture) throw new Error("missing fixture")
    const root = html(
      mount(TurnActivityComponent, {
        turn: fixture.turn,
        now: () => fixture.now,
        nested: fixture.nested,
      }),
    )
    const text = root.querySelector(".b4-turn__text")
    expect(text?.textContent).toBe("Reading a.md")
    expect(text?.getAttribute("data-live")).toBe("true")
    expect(root.querySelector(".b4-turn__time")?.textContent).toBe("· 5s")
  })

  test("a settled research turn opens one row per top-level step, nested rows staying folded", () => {
    const fixture = TURN_FIXTURES["done research turn"]
    if (!fixture) throw new Error("missing fixture")
    const mounted = mount(TurnActivityComponent, { turn: fixture.turn, now: () => fixture.now })
    const root = html(mounted)
    expect(root.querySelector(".b4-turn__time")?.textContent).toBe("· 8 steps · 2 sources")
    click(mounted, root.querySelector("button.b4-turn__summary"))
    const kinds = Array.from(root.querySelectorAll("section > ol > li"), (li) =>
      li.getAttribute("data-kind"),
    )
    expect(kinds).toEqual(["reasoning", "plan", "group", "subagent", "tool"])
  })
})
