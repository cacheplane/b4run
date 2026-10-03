// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PageActions } from "./PageActions"

const roots: ReturnType<typeof createRoot>[] = []
const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("# Tools\n")),
  )
})
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

async function render(promptBody?: string) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () =>
    root.render(<PageActions slug="tools" {...(promptBody ? { promptBody } : {})} />),
  )
  return container
}

const trigger = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') as HTMLButtonElement
const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const status = (c: HTMLElement) => c.querySelector('[role="status"]')?.textContent ?? ""
const key = (target: HTMLElement, k: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
  })

describe("page actions menu", () => {
  it("renders the same visible controls on every page", async () => {
    const withPrompt = await render("prompt")
    const without = await render()
    const visible = (c: HTMLElement) =>
      [...c.querySelectorAll("[data-page-actions] > button")].map((b) => b.textContent)
    expect(visible(withPrompt)).toEqual(visible(without))
    expect(visible(without)).toEqual(["Copy page", ""])
  })

  it("moves focus into the menu, cycles with arrows, and returns focus on Escape", async () => {
    const c = await render("prompt")
    const button = trigger(c)
    button.focus()
    await act(async () => button.click())
    const all = items(c)
    expect(
      all.map((item) => item.querySelector("span > span")?.childNodes[0]?.textContent),
    ).toEqual(["Copy agent prompt", "Open in ChatGPT", "Open in Claude", "Edit on GitHub"])
    expect(document.activeElement).toBe(all[0])
    expect(all.every((item) => item.tabIndex === -1)).toBe(true)
    await key(all[0] as HTMLElement, "ArrowDown")
    expect(document.activeElement).toBe(all[1])
    await key(all[1] as HTMLElement, "End")
    expect(document.activeElement).toBe(all[3])
    await key(all[3] as HTMLElement, "ArrowDown")
    expect(document.activeElement).toBe(all[0])
    await key(all[0] as HTMLElement, "ArrowUp")
    expect(document.activeElement).toBe(all[3])
    await key(all[3] as HTMLElement, "Escape")
    expect(items(c)).toHaveLength(0)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(button)
  })

  it("opens on ArrowUp with the last item focused", async () => {
    const c = await render()
    await key(trigger(c), "ArrowUp")
    expect(document.activeElement).toBe(items(c).at(-1))
  })

  it("opens assistants in a new tab as real links", async () => {
    const c = await render()
    await act(async () => trigger(c).click())
    const claude = items(c).find((item) => item.textContent?.includes("Open in Claude"))
    expect(claude?.tagName).toBe("A")
    expect(claude?.getAttribute("href")).toMatch(/^https:\/\/claude\.ai\/new\?q=/)
    expect(claude?.getAttribute("target")).toBe("_blank")
  })

  it("announces a copied page and a copied prompt", async () => {
    const c = await render("the prompt")
    await act(async () => c.querySelector<HTMLButtonElement>("[data-copy-page]")?.click())
    expect(writeText).toHaveBeenCalledWith("# Tools\n")
    expect(status(c)).toBe("Page copied")

    await act(async () => trigger(c).click())
    await act(async () => items(c)[0]?.click())
    expect(writeText).toHaveBeenLastCalledWith("the prompt")
    expect(status(c)).toBe("Prompt copied")
    expect(document.activeElement).toBe(trigger(c))
  })

  it("shows an error when copying fails", async () => {
    writeText.mockRejectedValue(new Error("denied"))
    const c = await render()
    await act(async () => c.querySelector<HTMLButtonElement>("[data-copy-page]")?.click())
    expect(status(c)).toBe("Copy failed")
    expect(c.querySelector('[role="status"]')?.className).not.toContain("sr-only")
  })
})
