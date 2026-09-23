// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Callout } from "../mdx/Callout"
import { DocsBrandProvider } from "./DocsBrandProvider"
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

describe("docs brand boundary", () => {
  it.each([
    ["info", "Info"],
    ["tip", "Tip"],
    ["warn", "Warning"],
    ["danger", "Danger"],
  ] as const)("identifies untitled %s callouts only inside docs", async (type, label) => {
    const docs = await render(
      <DocsBrandProvider>
        <Callout type={type}>Keep this body</Callout>
      </DocsBrandProvider>,
    )
    expect(docs.textContent).toContain(label)
    expect(docs.textContent).toContain("Keep this body")
    const elsewhere = await render(<Callout type={type}>Keep this body</Callout>)
    expect(elsewhere.textContent).not.toContain(label)
  })
  it("keeps custom callout titles and scopes the site-wide search panel", async () => {
    const container = await render(
      <DocsBrandProvider>
        <Callout title="Before you deploy">Body</Callout>
      </DocsBrandProvider>,
    )
    expect(container.textContent).toContain("Before you deploy")
    // The search dialog is mounted in the site header, outside any docs
    // layout, so its panel carries the docs palette itself.
    const search = await render(<DocsSearch />)
    const panel = search.querySelector("dialog[data-docs-search-dialog] > [data-docs-brand]")
    expect(panel).not.toBeNull()
    expect(search.querySelector("dialog")?.hasAttribute("data-docs-brand")).toBe(false)
  })
})
