// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Callout } from "../mdx/Callout"
import { DocsCalloutLabelsProvider } from "./DocsCalloutLabels"
import { DocsSearch } from "./DocsSearch"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/docs/tools",
}))
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})
async function render(node: React.ReactNode) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(node))
  return container
}

describe("docs-only callout labels, and the search dialog styled without a docs scope", () => {
  it.each([
    ["info", "Info"],
    ["tip", "Tip"],
    ["warn", "Warning"],
    ["danger", "Danger"],
  ] as const)("identifies untitled %s callouts only inside docs", async (type, label) => {
    const docs = await render(
      <DocsCalloutLabelsProvider>
        <Callout type={type}>Keep this body</Callout>
      </DocsCalloutLabelsProvider>,
    )
    expect(docs.textContent).toContain(label)
    expect(docs.textContent).toContain("Keep this body")
    const elsewhere = await render(<Callout type={type}>Keep this body</Callout>)
    expect(elsewhere.textContent).not.toContain(label)
  })
  it("keeps custom callout titles and hooks the site-wide search dialog to ui.css", async () => {
    const container = await render(
      <DocsCalloutLabelsProvider>
        <Callout title="Before you deploy">Body</Callout>
      </DocsCalloutLabelsProvider>,
    )
    expect(container.textContent).toContain("Before you deploy")
    // The search dialog is mounted in the site header, outside any docs
    // layout; ui.css styles it through data-docs-search-dialog (the scrim on
    // the dialog, the panel as its first child), so no docs-only scope exists.
    const search = await render(<DocsSearch />)
    const dialog = search.querySelector("dialog[data-docs-search-dialog]")
    expect(dialog).not.toBeNull()
    expect(dialog?.hasAttribute("data-docs-search-overlay")).toBe(false)
    expect(dialog?.querySelector(":scope > div")).not.toBeNull()
    expect(search.querySelector("[data-docs-brand]")).toBeNull()
  })
})
