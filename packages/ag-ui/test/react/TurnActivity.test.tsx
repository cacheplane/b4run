// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TurnActivity } from "../../src/react/activity/TurnActivity.js"
import type { ToolStep, TurnView } from "../../src/view/turns.js"

/**
 * `Partial` that also accepts an explicit `undefined`, so a case can unset a
 * default (`endedAt: undefined`); {@link compact} then drops the key, which
 * `exactOptionalPropertyTypes` requires of the built view.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const tool = (id: string, o: Loose<ToolStep> = {}): ToolStep =>
  compact<ToolStep>({
    kind: "tool",
    id,
    name: "searchCorpus",
    status: "done",
    args: "",
    startedAt: 0,
    settledAt: 500,
    label: "Searched the corpus",
    icon: "search",
    ...o,
  })
const turn = (o: Loose<TurnView>): TurnView =>
  compact<TurnView>({
    runId: "r",
    status: "done",
    startedAt: 0,
    endedAt: 72_000,
    steps: [tool("a"), tool("b")],
    text: "",
    approvals: [],
    failed: 0,
    ...o,
  })
const zero = () => 0

describe("TurnActivity", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("a working turn is open, shimmers the active label, ticks the time and announces once per label", () => {
    let clock = 12_400
    const now = () => clock
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
    render(<TurnActivity turn={working} now={now} />)
    const root = screen.getByTestId("turn")
    expect(root.getAttribute("data-state")).toBe("working")
    expect(root.getAttribute("data-expanded")).toBe("true")
    const summary = screen.getByRole("button", { expanded: true, name: /Searching the corpus/ })
    expect(summary.querySelector(".b4-turn__text")?.textContent).toBe("Searching the corpus")
    expect(summary.querySelector(".b4-turn__text")?.getAttribute("data-live")).toBe("true")
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 12s")
    const status = screen.getByRole("status")
    expect(status.textContent).toBe("Searching the corpus")
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(status, { childList: true, characterData: true, subtree: true })
    act(() => {
      clock = 13_400
      vi.advanceTimersByTime(1000)
    })
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 13s")
    expect(status.textContent).toBe("Searching the corpus")
    expect(observer.takeRecords().concat(mutations)).toHaveLength(0) // the tick never touches the live region
    observer.disconnect()
    // One done call and one running call: nothing merges while a call is live.
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  test("a settled turn starts folded with the Worked for summary; clicking opens the steps", () => {
    const markup = renderToStaticMarkup(
      <TurnActivity
        turn={turn({ steps: [tool("a"), tool("b", { name: "readDoc", label: "Read a.md" })] })}
        now={zero}
      />,
    )
    expect(markup).toContain('<section class="b4-turn" data-state="done" data-testid="turn">')
    expect(markup).toContain(
      '<span class="b4-turn__text">Worked for 1m 12s</span><span class="b4-turn__time">· 2 steps</span>',
    )
    expect(markup).not.toContain("b4-turn__steps")
    render(<TurnActivity turn={turn({})} now={zero} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("list")).toBeTruthy()
  })

  test("a live turn that settles folds; a failed step keeps the turn state failed and opens the step", () => {
    const live = turn({ status: "working", endedAt: undefined })
    const now1 = () => 1000
    const now2 = () => 2000
    const { rerender } = render(<TurnActivity turn={live} now={now1} />)
    expect(screen.getByTestId("turn").getAttribute("data-expanded")).toBe("true")
    rerender(
      <TurnActivity
        turn={turn({
          status: "failed",
          failed: 1,
          steps: [
            tool("a", { status: "failed", result: "ENOENT", label: "Couldn't read plan.md" }),
          ],
        })}
        now={now2}
      />,
    )
    expect(screen.getByTestId("turn").getAttribute("data-state")).toBe("failed")
    expect(screen.getByTestId("turn").getAttribute("data-expanded")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }))
    expect(
      screen.getByText("Couldn't read plan.md").closest("li")?.getAttribute("data-expanded"),
    ).toBe("true")
    expect(screen.getByText("· 1 step · 1 failed")).toBeTruthy()
  })

  test("awaiting turns read Waiting for your approval and stay open", () => {
    const now = () => 38_000
    const markup = renderToStaticMarkup(
      <TurnActivity
        turn={turn({
          status: "awaiting",
          endedAt: undefined,
          steps: [tool("a", { status: "awaiting", label: "Wants to run a command" })],
        })}
        now={now}
      />,
    )
    expect(markup).toContain('data-state="awaiting" data-expanded="true"')
    expect(markup).toContain(">Waiting for your approval<")
    expect(markup).toContain("· awaiting approval")
  })

  test("nested turns name the subagent", () => {
    const markup = renderToStaticMarkup(
      <TurnActivity turn={turn({})} now={zero} nested={{ name: "researcher", status: "done" }} />,
    )
    expect(markup).toContain(
      '<span class="b4-turn__text">researcher finished</span><span class="b4-turn__time">· 2 steps</span>',
    )
    const paused = renderToStaticMarkup(
      <TurnActivity
        turn={turn({ status: "awaiting", endedAt: undefined })}
        now={zero}
        nested={{ name: "researcher", status: "paused" }}
      />,
    )
    expect(paused).toContain(">researcher · paused<")
  })
})
