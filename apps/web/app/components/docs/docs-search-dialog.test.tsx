// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DocsSearch, DocsSearchTrigger } from "./DocsSearch"
import { openDocsSearch, resetDocsSearchIndex } from "./docs-search-events"
import type { DocsSearchEntry } from "./search-index"

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/docs/retry",
}))

const INDEX: readonly DocsSearchEntry[] = [
  {
    href: "/docs/retry",
    title: "Retry",
    section: "Agent Capabilities",
    headings: [{ text: "Backoff", level: 2, anchor: "backoff" }],
    sections: [
      { anchor: null, text: "Retries transient model failures.", terms: [] },
      { anchor: "backoff", text: "Backoff is exponential with jitter.", terms: [] },
    ],
    aliases: [],
    canonicalAliases: [],
    aliasSurfaces: {},
  },
  {
    href: "/docs/api/sdk",
    title: "@b4run/sdk",
    section: "API Reference",
    headings: [],
    sections: [],
    aliases: ["agent"],
    canonicalAliases: ["agent"],
    aliasSurfaces: { agent: "@b4run/sdk" },
  },
]

// jsdom has no modal dialog support; model the parts the component uses.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "")
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open")
    this.dispatchEvent(new Event("close"))
  }
})

const fetchMock = vi.fn()
beforeEach(() => {
  resetDocsSearchIndex()
  push.mockReset()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify(INDEX)))
  vi.stubGlobal("fetch", fetchMock)
})

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

async function render() {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () =>
    root.render(
      <>
        <DocsSearchTrigger />
        <DocsSearch />
      </>,
    ),
  )
  return container
}

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-docs-search-dialog]")
const input = () => dialog()?.querySelector<HTMLInputElement>('[role="combobox"]') ?? null
const options = () => [...(dialog()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
const status = () => dialog()?.querySelector('[role="status"]')?.textContent ?? ""
const flushTimers = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

async function openFromTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>("[data-docs-search-trigger]")
  if (!trigger) throw new Error("no trigger")
  trigger.focus()
  await act(async () => trigger.click())
  await flushTimers()
  return trigger
}

async function type(value: string) {
  const field = input()
  if (!field) throw new Error("no input")
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
  })
}

describe("docs search dialog", () => {
  it("opens as a native modal dialog and fetches the index only on first open", async () => {
    const container = await render()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dialog()?.open).toBe(false)
    await openFromTrigger(container)
    expect(dialog()?.open).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith("/search-index.json")
    expect(document.activeElement).toBe(input())
  })

  it("is an ARIA combobox that points at the active option and announces the count", async () => {
    const container = await render()
    await openFromTrigger(container)
    const field = input() as HTMLInputElement
    expect(field.getAttribute("aria-label")).toBe("Search docs")
    const listbox = dialog()?.querySelector('[role="listbox"]')
    expect(field.getAttribute("aria-controls")).toBe(listbox?.id)

    await type("backoff")
    expect(status()).toBe("1 result")
    const [first] = options()
    expect(field.getAttribute("aria-activedescendant")).toBe(first?.id)
    expect(first?.getAttribute("aria-selected")).toBe("true")

    await type("zzzz-nothing")
    expect(status()).toBe("No results for “zzzz-nothing”")
    expect(field.hasAttribute("aria-activedescendant")).toBe(false)
    expect(field.getAttribute("aria-expanded")).toBe("false")
  })

  it("moves the active option with the arrow keys, wrapping, and navigates on Enter", async () => {
    const container = await render()
    await openFromTrigger(container)
    await type("r")
    const field = input() as HTMLInputElement
    const count = options().length
    expect(count).toBeGreaterThan(1)
    await key(field, { key: "ArrowDown" })
    expect(field.getAttribute("aria-activedescendant")).toBe(options()[1]?.id)
    await key(field, { key: "ArrowUp" })
    await key(field, { key: "ArrowUp" })
    expect(field.getAttribute("aria-activedescendant")).toBe(options()[count - 1]?.id)
    await key(field, { key: "Enter" })
    expect(push).toHaveBeenCalledTimes(1)
    expect(dialog()?.open).toBe(false)
  })

  it("names the export an API page matched through", async () => {
    const container = await render()
    await openFromTrigger(container)
    await type("agent")
    const match = options()[0]?.querySelector('[data-search-match="alias"]')
    expect(match?.textContent).toBe("agent in @b4run/sdk")
  })

  it("shows a body-text snippet without raw Markdown heading markers", async () => {
    const container = await render()
    await openFromTrigger(container)
    await type("jitter")
    const [hit] = options()
    expect(hit?.textContent).toContain("Backoff")
    expect(hit?.textContent).not.toContain("#")
    expect(hit?.querySelector("mark")?.textContent).toBe("jitter")
  })

  it("closes on Escape and returns focus to the trigger", async () => {
    const container = await render()
    const trigger = await openFromTrigger(container)
    await key(input() as HTMLInputElement, { key: "Escape" })
    expect(dialog()?.open).toBe(false)
    await flushTimers()
    expect(document.activeElement).toBe(trigger)
  })

  it("opens with Cmd/Ctrl-K and with / outside text fields, but not / while typing", async () => {
    await render()
    await key(window, { key: "k", metaKey: true })
    expect(dialog()?.open).toBe(true)
    await key(input() as HTMLInputElement, { key: "Escape" })
    await key(window, { key: "k", ctrlKey: true })
    expect(dialog()?.open).toBe(true)
    await key(input() as HTMLInputElement, { key: "Escape" })

    await key(document.body, { key: "/" })
    expect(dialog()?.open).toBe(true)
    await key(input() as HTMLInputElement, { key: "Escape" })

    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    await key(textarea, { key: "/" })
    expect(dialog()?.open).toBe(false)
  })

  it("opens from another trigger via the open event and returns focus to it", async () => {
    await render()
    const external = document.createElement("button")
    document.body.append(external)
    external.focus()
    await act(async () => openDocsSearch())
    expect(dialog()?.open).toBe(true)
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>('[aria-label="Close search"]')?.click(),
    )
    expect(dialog()?.open).toBe(false)
    await flushTimers()
    expect(document.activeElement).toBe(external)
  })

  it("reports a failed index fetch and retries it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }))
    const container = await render()
    await openFromTrigger(container)
    expect(status()).toMatch(/unavailable/)
    await act(async () =>
      [...(dialog()?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "Try again")
        ?.click(),
    )
    await flushTimers()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await type("retry")
    expect(options().length).toBeGreaterThan(0)
  })
})
