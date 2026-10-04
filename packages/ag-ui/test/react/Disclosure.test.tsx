// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Disclosure, useDisclosure } from "../../src/react/activity/Disclosure.js"
import { useElapsed, useLive } from "../../src/react/activity/useLive.js"
import type { ToolStep } from "../../src/view/turns.js"

describe("Disclosure", () => {
  test("renders a controlled button with aria-expanded and the panel only while open", () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <Disclosure open={false} onToggle={onToggle} className="x" summary={<span>sum</span>}>
        <p>panel</p>
      </Disclosure>,
    )
    const button = screen.getByRole("button", { name: "sum" })
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("panel")).toBeNull()
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(button.getAttribute("aria-expanded")).toBe("false") // controlled: nothing moves until the parent says so
    rerender(
      <Disclosure open={true} onToggle={onToggle} className="x" summary={<span>sum</span>}>
        <p>panel</p>
      </Disclosure>,
    )
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("panel")).toBeTruthy()
  })
})

describe("useDisclosure", () => {
  function Probe({
    autoOpen,
    live,
    resetKey,
  }: {
    autoOpen: boolean
    live: boolean
    resetKey?: unknown
  }) {
    const { open, toggle } = useDisclosure(autoOpen, live, resetKey)
    return (
      <button type="button" aria-expanded={open} onClick={toggle}>
        t
      </button>
    )
  }
  const expanded = () => screen.getByRole("button").getAttribute("aria-expanded")

  test("automation decides until the user toggles; without a key the choice clears when the item becomes live again", () => {
    const { rerender } = render(<Probe autoOpen={true} live={true} />)
    expect(expanded()).toBe("true")
    fireEvent.click(screen.getByRole("button"))
    expect(expanded()).toBe("false")
    rerender(<Probe autoOpen={false} live={false} />)
    expect(expanded()).toBe("false")
    rerender(<Probe autoOpen={true} live={true} />)
    expect(expanded()).toBe("true")
  })

  test("mounting live does not clear a choice made after mount", () => {
    const { rerender } = render(<Probe autoOpen={false} live={true} resetKey={100} />)
    fireEvent.click(screen.getByRole("button"))
    expect(expanded()).toBe("true")
    rerender(<Probe autoOpen={false} live={true} resetKey={100} />)
    expect(expanded()).toBe("true")
  })

  test("with a key, live rising under the same key keeps the user's choice; a new key hands back to automation", () => {
    const { rerender } = render(<Probe autoOpen={false} live={false} resetKey={100} />)
    fireEvent.click(screen.getByRole("button"))
    expect(expanded()).toBe("true")
    rerender(<Probe autoOpen={false} live={true} resetKey={100} />) // awaiting → running, same call
    expect(expanded()).toBe("true")
    rerender(<Probe autoOpen={false} live={true} resetKey={200} />) // restarted call
    expect(expanded()).toBe("false")
    fireEvent.click(screen.getByRole("button"))
    rerender(<Probe autoOpen={false} live={false} resetKey={300} />) // key changes while settled: nothing yet
    expect(expanded()).toBe("true")
    rerender(<Probe autoOpen={false} live={true} resetKey={300} />) // …until it is live under the new key
    expect(expanded()).toBe("false")
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
    const five = () => 5000
    const old = render(<Probe step={step("running", 0)} now={five} />)
    expect(old.container.textContent).toBe("true:5000")
    const done = render(<Probe step={step("done", 0)} now={five} />)
    expect(done.container.textContent).toBe("false:5000")
  })

  test("elapsed re-samples the clock every second while active", () => {
    let clock = 0
    const now = () => clock
    render(<Probe step={step("running", 0)} now={now} />)
    act(() => {
      clock = 2500
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole("status").textContent?.endsWith(":2500")).toBe(true)
  })

  test("an unstable now identity neither recreates the interval nor re-arms the no-flash timer", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval")
    const setTimeout = vi.spyOn(globalThis, "setTimeout")
    let clock = 1000
    const { rerender } = render(<Probe step={step("running", 1000)} now={() => clock} />)
    expect(setInterval).toHaveBeenCalledTimes(1)
    const armed = setTimeout.mock.calls.length
    rerender(<Probe step={step("running", 1000)} now={() => clock} />)
    rerender(<Probe step={step("running", 1000)} now={() => clock} />)
    expect(setInterval).toHaveBeenCalledTimes(1)
    expect(setTimeout).toHaveBeenCalledTimes(armed)
    act(() => {
      clock = 3000
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole("status").textContent).toBe("true:3000") // the interval reads the latest clock
  })
})
