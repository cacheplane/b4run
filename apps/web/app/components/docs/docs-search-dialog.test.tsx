// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocsSearch } from "./DocsSearch"
import { openDocsSearch } from "./docs-search-events"
import type { DocsSearchEntry } from "./search-index"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const INDEX: readonly DocsSearchEntry[] = [
  {
    href: "/docs/retry",
    title: "Retry",
    section: "Operate",
    headings: [{ text: "Backoff", level: 2, anchor: "backoff" }],
    aliases: [],
    canonicalAliases: [],
  },
]

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})

async function render() {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<DocsSearch index={INDEX} />))
  return container
}

const dialog = () => document.querySelector('[role="dialog"]')
const flushTimers = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

describe("docs search dialog", () => {
  it("labels the search input", async () => {
    const container = await render()
    await act(async () => container.querySelector("button")?.click())
    expect(dialog()?.querySelector("input")?.getAttribute("aria-label")).toBe("Search docs")
  })

  it("closes on Escape from a focused result and returns focus to the trigger", async () => {
    const container = await render()
    const trigger = container.querySelector("button") as HTMLButtonElement
    trigger.focus()
    await act(async () => trigger.click())
    const result = dialog()?.querySelector<HTMLButtonElement>("ul button")
    expect(result).toBeTruthy()
    result?.focus()
    await act(async () => {
      result?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(dialog()).toBeNull()
    await flushTimers()
    expect(document.activeElement).toBe(trigger)
  })

  it("closes on Escape from the input", async () => {
    const container = await render()
    await act(async () => container.querySelector("button")?.click())
    const input = dialog()?.querySelector("input")
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(dialog()).toBeNull()
  })

  it("opens from another trigger via the open event and returns focus to it", async () => {
    await render()
    const external = document.createElement("button")
    document.body.append(external)
    external.focus()
    await act(async () => openDocsSearch())
    expect(dialog()).not.toBeNull()
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>('[aria-label="Close search"]')?.click(),
    )
    expect(dialog()).toBeNull()
    await flushTimers()
    expect(document.activeElement).toBe(external)
  })
})
