import { afterEach, describe, expect, it, vi } from "vitest"

const dispatchCustomEvent = vi.hoisted(() => vi.fn())
vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent }))

import {
  describeDone,
  describeRunning,
  dispatchStep,
  type StepPayload,
} from "../src/tool-display.ts"

const uid = (n: string) => `${n}-${crypto.randomUUID()}`

afterEach(() => {
  vi.restoreAllMocks()
  dispatchCustomEvent.mockReset()
})

describe("describeRunning / describeDone", () => {
  it("returns the icon and label", () => {
    const display = { icon: "search" as const, running: (i: { q: string }) => `Searching ${i.q}` }
    expect(describeRunning(display, { q: "agents" }, "searchCorpus")).toEqual({
      icon: "search",
      label: "Searching agents",
    })
  })

  it("returns undefined label when the field is absent, but still the icon", () => {
    expect(describeRunning({ icon: "read" }, {}, "readDoc")).toEqual({ icon: "read" })
    expect(describeDone({ icon: "read" }, {}, "x", "readDoc")).toEqual({ icon: "read" })
  })

  it("truncates a long label at 120 characters with an ellipsis", () => {
    const label = "x".repeat(200)
    const out = describeRunning({ running: () => label }, {}, "t")
    expect(out.label).toHaveLength(120)
    expect(out.label?.endsWith("…")).toBe(true)
  })

  it("falls back and warns once per tool and field when a label throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const flaky = uid("flaky")
    const display = {
      running: () => {
        throw new Error("boom")
      },
    }
    expect(describeRunning(display, {}, flaky)).toEqual({})
    expect(describeRunning(display, {}, flaky)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(
      new RegExp(`display\\.running for tool "${flaky}" threw`),
    )
  })

  it("coerces non-string labels and drops malformed sources", () => {
    const display = {
      done: () => 42 as unknown as string,
      sources: () =>
        [{ title: "a.md" }, { title: 3 }, "x", { title: "b.md", href: "http://b" }] as never,
    }
    const out: StepPayload = describeDone(display, {}, {}, "t")
    expect(out).toEqual({
      label: "42",
      sources: [{ title: "a.md" }, { title: "b.md", href: "http://b" }],
    })
  })

  it("treats empty and whitespace labels as no label", () => {
    expect("label" in describeRunning({ running: () => "" }, {}, uid("e"))).toBe(false)
    expect("label" in describeRunning({ running: () => "   " }, {}, uid("e"))).toBe(false)
  })

  it("rejects a non-text label and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = describeRunning({ running: () => ({}) as never }, {}, uid("obj"))
    expect("label" in out).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/returned a non-text value/)
  })

  it("done throwing yields no label and a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = describeDone(
      {
        done: () => {
          throw new Error("x")
        },
      },
      {},
      {},
      uid("d"),
    )
    expect("label" in out).toBe(false)
    expect(warn.mock.calls[0]?.[0]).toMatch(/display\.done for tool/)
  })

  it("sources throwing yields no sources key and a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = describeDone(
      {
        sources: () => {
          throw new Error("x")
        },
      },
      {},
      {},
      uid("s"),
    )
    expect("sources" in out).toBe(false)
    expect(warn.mock.calls[0]?.[0]).toMatch(/display\.sources .* showing no sources/)
  })

  it("sources returning a non-array leaves the key absent without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = describeDone({ sources: () => "nope" as never }, {}, {}, uid("n"))
    expect("sources" in out).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it("drops an empty href", () => {
    const out = describeDone({ sources: () => [{ title: "a", href: "" }] }, {}, {}, uid("h"))
    expect(out.sources).toEqual([{ title: "a" }])
  })

  it("never cuts inside a surrogate pair when truncating", () => {
    const label = `x${"😀".repeat(100)}`
    const out = describeRunning({ running: () => label }, {}, uid("emoji"))
    expect(out.label?.length).toBeLessThanOrEqual(120)
    expect(out.label).not.toMatch(/[\uD800-\uDBFF]…$/)
    expect(out.label?.endsWith("…")).toBe(true)
  })

  it("dispatchStep resolves when dispatching rejects", async () => {
    dispatchCustomEvent.mockRejectedValue(new Error("no run"))
    await expect(
      dispatchStep(undefined, { tool_call_id: "c1", status: "running" }),
    ).resolves.toBeUndefined()
    expect(dispatchCustomEvent).toHaveBeenCalledWith(
      "b4.step",
      { tool_call_id: "c1", status: "running" },
      undefined,
    )
  })
})
