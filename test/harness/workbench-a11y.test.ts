import type { Locator, Page } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

import {
  AXE_TAGS,
  type AxeFactory,
  type AxeViolation,
  assertNoSeriousAxeViolations,
  assertRestoredTurnAccessible,
  CHAT_DOCK_SELECTOR,
  tabUntilFocused,
} from "./workbench-a11y.ts"

function fakeAxe(violations: readonly AxeViolation[]) {
  const calls: unknown[] = []
  const scan = {
    include: vi.fn((selector: string) => {
      calls.push(["include", selector])
      return scan
    }),
    withTags: vi.fn((tags: string[]) => {
      calls.push(["withTags", tags])
      return scan
    }),
    analyze: vi.fn(async () => {
      calls.push("analyze")
      return { violations }
    }),
  }
  const axe: AxeFactory = vi.fn(() => scan)
  return { axe, calls }
}

const page = {} as Page

describe("assertNoSeriousAxeViolations", () => {
  it("scans the chat dock for WCAG A/AA by default", async () => {
    const { axe, calls } = fakeAxe([])
    await assertNoSeriousAxeViolations(page, { axe })
    expect(axe).toHaveBeenCalledWith(page)
    expect(calls).toEqual([["include", CHAT_DOCK_SELECTOR], ["withTags", [...AXE_TAGS]], "analyze"])
  })

  it("passes minor and moderate findings", async () => {
    const { axe } = fakeAxe([
      { id: "region", impact: "moderate", nodes: [{ target: ["div"] }] },
      { id: "landmark-unique", impact: "minor", nodes: [{ target: ["nav"] }] },
    ])
    await expect(assertNoSeriousAxeViolations(page, { axe })).resolves.toBeUndefined()
  })

  it("fails on a serious or critical violation, naming the rule, its count and its nodes", async () => {
    const { axe } = fakeAxe([
      { id: "color-contrast", impact: "serious", nodes: [{ target: [".b4-turn__time"] }] },
      {
        id: "button-name",
        impact: "critical",
        nodes: [{ target: ["#a"] }, { target: ["#b"] }, { target: ["#c"] }, { target: ["#d"] }],
      },
      { id: "region", impact: "moderate", nodes: [{ target: ["div"] }] },
    ])
    const rejection = assertNoSeriousAxeViolations(page, { axe, when: "with the approval open" })
    await expect(rejection).rejects.toThrow(
      /in section\[aria-label="Chat"\] with the approval open: color-contrast \[serious\] \(1\): \[".b4-turn__time"\]; button-name \[critical\] \(4\): \["#a"\], \["#b"\], \["#c"\], …$/,
    )
    await expect(rejection).rejects.not.toThrow(/region/)
  })

  it("scans another region when asked", async () => {
    const { axe, calls } = fakeAxe([])
    await assertNoSeriousAxeViolations(page, { axe, include: "main" })
    expect(calls[0]).toEqual(["include", "main"])
  })
})

/** A page whose focus moves one element per Tab press through `order`. */
function focusPage(order: readonly string[], start = 0) {
  let index = start
  const presses: string[] = []
  const fakePage = {
    keyboard: {
      press: vi.fn(async (key: string) => {
        presses.push(key)
        index = key === "Shift+Tab" ? index - 1 : index + 1
      }),
    },
  } as unknown as Page
  const target = (name: string) =>
    ({
      evaluate: vi.fn(async () => order[index] === name),
    }) as unknown as Locator
  return { page: fakePage, presses, target }
}

describe("tabUntilFocused", () => {
  it("returns at once when the target already has focus", async () => {
    const { page: p, presses, target } = focusPage(["textbox"])
    await tabUntilFocused(p, target("textbox"))
    expect(presses).toEqual([])
  })

  it("presses Tab until the target has focus", async () => {
    const { page: p, presses, target } = focusPage(["textbox", "send", "summary"])
    await tabUntilFocused(p, target("summary"))
    expect(presses).toEqual(["Tab", "Tab"])
  })

  it("presses Shift+Tab when going backwards", async () => {
    const { page: p, presses, target } = focusPage(["summary", "step", "textbox"], 2)
    await tabUntilFocused(p, target("summary"), { backwards: true })
    expect(presses).toEqual(["Shift+Tab", "Shift+Tab"])
  })

  it("fails when Tab never reaches the target", async () => {
    const { page: p, presses, target } = focusPage(["a", "b", "c", "d", "e", "f"])
    await expect(
      tabUntilFocused(p, target("nowhere"), { maxTabs: 4, what: "Allow once" }),
    ).rejects.toThrow("Allow once never took focus after 4 Tab presses")
    expect(presses).toHaveLength(4)
  })
})

/**
 * A restored thread for the keyboard pass: focus moves through `order` one
 * element per Tab, Enter toggles the focused disclosure, and every step taken
 * is recorded.
 */
function restoredPage(
  options: { readonly summaryStartsOpen?: boolean; readonly deaf?: string } = {},
) {
  const order = ["summary", "line", "copy", "textbox"]
  let focus = -1
  const expanded = new Map<string, boolean>([
    ["summary", options.summaryStartsOpen ?? true],
    ["line", false],
  ])
  const calls: string[] = []
  const named = (desc: string): string | undefined =>
    desc.endsWith("button.b4-turn__summary")
      ? "summary"
      : desc.endsWith("button.b4-step__line")
        ? "line"
        : undefined
  // biome-ignore lint/suspicious/noExplicitAny: a structural stand-in for Locator.
  const locator = (desc: string): any => ({
    locator: (selector: string) => locator(`${desc} > ${selector}`),
    first: () => locator(`${desc} .first`),
    last: () => locator(`${desc} .last`),
    focus: async () => {
      calls.push(`focus ${desc}`)
      focus = order.indexOf("textbox")
    },
    evaluate: async () => order[focus] === named(desc),
    getAttribute: async (name: string) => {
      const key = named(desc)
      return name === "aria-expanded" && key !== undefined ? String(expanded.get(key)) : null
    },
  })
  const fakePage = {
    getByRole: (role: string) => locator(role === "main" ? "main" : `role=${role}`),
    keyboard: {
      press: vi.fn(async (key: string) => {
        calls.push(key)
        if (key === "Tab") focus += 1
        else if (key === "Shift+Tab") focus -= 1
        else if (key === "Enter") {
          const name = order[focus]
          if (name !== undefined && name !== options.deaf && expanded.has(name)) {
            expanded.set(name, !expanded.get(name))
          }
        }
      }),
    },
  } as unknown as Page
  return { page: fakePage, calls, expanded }
}

describe("assertRestoredTurnAccessible", () => {
  it("scans the dock, then flips the turn and opens its first step by keyboard alone", async () => {
    const { axe, calls: axeCalls } = fakeAxe([])
    const { page: p, calls, expanded } = restoredPage()
    await assertRestoredTurnAccessible(p, { turnSelector: "section.b4-turn", axe })
    expect(axeCalls).toContainEqual(["include", CHAT_DOCK_SELECTOR])
    expect(calls).toEqual([
      "focus role=textbox",
      // textbox → copy → line → summary
      "Shift+Tab",
      "Shift+Tab",
      "Shift+Tab",
      // open → closed, then open again so the steps are back in the DOM
      "Enter",
      "Enter",
      "Tab",
      "Enter",
    ])
    expect(expanded.get("summary")).toBe(true)
    expect(expanded.get("line")).toBe(true)
  })

  it("opens a folded turn with one Enter", async () => {
    const { axe } = fakeAxe([])
    const { page: p, calls } = restoredPage({ summaryStartsOpen: false })
    await assertRestoredTurnAccessible(p, { turnSelector: "section.b4-turn", axe })
    expect(calls.filter((call) => call === "Enter")).toHaveLength(2)
  })

  it("fails when Enter does not toggle the focused disclosure", async () => {
    const { axe } = fakeAxe([])
    const { page: p } = restoredPage({ deaf: "line" })
    await expect(
      assertRestoredTurnAccessible(p, { turnSelector: "section.b4-turn", axe, timeoutMs: 200 }),
    ).rejects.toThrow(/first step stayed aria-expanded=false after Enter, expected true/)
  })

  it("fails on a serious axe violation before touching the keyboard", async () => {
    const { axe } = fakeAxe([{ id: "color-contrast", impact: "serious", nodes: [] }])
    const { page: p, calls } = restoredPage()
    await expect(
      assertRestoredTurnAccessible(p, { turnSelector: "section.b4-turn", axe }),
    ).rejects.toThrow(/after the restore: color-contrast/)
    expect(calls).toEqual([])
  })
})
