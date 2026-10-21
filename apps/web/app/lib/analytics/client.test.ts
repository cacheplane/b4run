// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock("posthog-js", () => ({ default: { capture } }))

import { copyCodeEventFor, safeLabel, sourcePage, track } from "./client"
import { SIGNAL_EVENTS } from "./events"

beforeEach(() => {
  capture.mockReset()
})

describe("track", () => {
  it("adds source_page as a pathname and drops search and hash", () => {
    history.replaceState(null, "", "/docs/agents?x=1#top")
    track(SIGNAL_EVENTS.docsSearchOpen)
    expect(capture).toHaveBeenCalledWith("docs:search_open", {
      source_page: "/docs/agents",
    })
  })

  it("keeps an explicit source_page and drops properties that are blank", () => {
    history.replaceState(null, "", "/")
    track(SIGNAL_EVENTS.siteCtaClick, {
      cta_id: "header_github",
      code_lang: "  ",
      source_page: "/blog/x",
    })
    expect(capture).toHaveBeenCalledWith("site:cta_click", {
      cta_id: "header_github",
      source_page: "/blog/x",
    })
  })

  it("caps string properties at 128 characters", () => {
    history.replaceState(null, "", "/")
    track(SIGNAL_EVENTS.docsCopyCodeClick, { code_lang: "a".repeat(200) })
    const props = capture.mock.calls[0]?.[1] as { code_lang: string }
    expect(props.code_lang).toHaveLength(128)
  })

  it("passes numeric properties through", () => {
    history.replaceState(null, "", "/")
    track(SIGNAL_EVENTS.siteEngagedTime, { engaged_seconds: 30 })
    expect(capture).toHaveBeenCalledWith("site:engaged_time", {
      engaged_seconds: 30,
      source_page: "/",
    })
  })

  it("never throws when capture throws", () => {
    capture.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(() => track(SIGNAL_EVENTS.docsSearchOpen)).not.toThrow()
  })
})

describe("safeLabel", () => {
  it("caps labels at 128 characters and rejects blanks", () => {
    expect(safeLabel("  ")).toBeUndefined()
    expect(safeLabel("a".repeat(200))).toHaveLength(128)
  })

  it("trims and rejects non-strings", () => {
    expect(safeLabel("  hi ")).toBe("hi")
    expect(safeLabel(42)).toBeUndefined()
    expect(safeLabel(undefined)).toBeUndefined()
  })
})

describe("sourcePage", () => {
  it.each([
    ["https://b4.run/docs/a?x=1#h", "/docs/a"],
    ["/docs/a?x=1#h", "/docs/a"],
    ["", "/"],
    ["http://[bad", "/"],
  ])("sourcePage(%s) is %s", (input, expected) => {
    expect(sourcePage(input)).toBe(expected)
  })
})

describe("copyCodeEventFor", () => {
  it.each([
    ["/docs/x", "docs:copy_code_click"],
    ["/blog/y", "blog:copy_code_click"],
    ["/", undefined],
  ])("copyCodeEventFor(%s)", (pathname, expected) => {
    expect(copyCodeEventFor(pathname)).toBe(expected)
  })
})
