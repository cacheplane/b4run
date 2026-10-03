import { afterEach, describe, expect, it, vi } from "vitest"
import { describeDone, describeRunning, type StepPayload } from "../src/tool-display.ts"

afterEach(() => vi.restoreAllMocks())

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
    const display = {
      running: () => {
        throw new Error("boom")
      },
    }
    expect(describeRunning(display, {}, "flaky")).toEqual({})
    expect(describeRunning(display, {}, "flaky")).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/display\.running for tool "flaky" threw/)
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
})
