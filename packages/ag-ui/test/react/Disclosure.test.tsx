// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Disclosure } from "../../src/react/activity/Disclosure.js"
import { useElapsed, useLive } from "../../src/react/activity/useLive.js"
import type { ToolStep } from "../../src/view/turns.js"

afterEach(cleanup)

describe("Disclosure", () => {
  test("renders a button with aria-expanded, toggles on click, and the panel only when open", () => {
    render(
      <Disclosure autoOpen={false} live={false} className="x" summary={<span>sum</span>}>
        <p>panel</p>
      </Disclosure>,
    )
    const button = screen.getByRole("button", { name: "sum" })
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("panel")).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("panel")).toBeTruthy()
  })

  test("a manual toggle wins until the item becomes live again", () => {
    const { rerender } = render(
      <Disclosure autoOpen={true} live={true} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("panel")).toBeNull()
    rerender(
      <Disclosure autoOpen={false} live={false} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    expect(screen.queryByText("panel")).toBeNull()
    rerender(
      <Disclosure autoOpen={true} live={true} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    expect(screen.getByText("panel")).toBeTruthy()
  })
})

describe("useLive / useElapsed", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function Probe({ step, now }: { step: ToolStep; now: () => number }) {
    const live = useLive(step, now)
    const t = useElapsed(step.status === "running", now)
    return <output>{`${live}:${t}`}</output>
  }
  const step = (status: ToolStep["status"], startedAt: number): ToolStep => ({
    kind: "tool",
    id: "a",
    name: "x",
    status,
    args: "",
    startedAt,
  })

  test("a running step is not live for its first 300 ms, then is", () => {
    let clock = 1000
    const now = () => clock
    render(<Probe step={step("running", 1000)} now={now} />)
    expect(screen.getByRole("status").textContent).toBe("false:1000")
    act(() => {
      clock = 1400
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByRole("status").textContent?.startsWith("true:")).toBe(true)
  })

  test("a step that starts old is live immediately; done is never live", () => {
    const old = render(<Probe step={step("running", 0)} now={() => 5000} />)
    expect(old.container.textContent).toBe("true:5000")
    const done = render(<Probe step={step("done", 0)} now={() => 5000} />)
    expect(done.container.textContent).toBe("false:5000")
  })

  test("elapsed re-samples the clock every second while active", () => {
    let clock = 0
    render(<Probe step={step("running", 0)} now={() => clock} />)
    act(() => {
      clock = 2500
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole("status").textContent?.endsWith(":2500")).toBe(true)
  })
})
