// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/memory" }))
// The SEO registry is unrelated to the anchors and reads generated build data.
vi.mock("../../seo/resolve", () => ({ resolveStaticSeoPage: () => undefined }))

import { DocsPage } from "./DocsPage"
import { LegacyAnchorRedirect, legacyNavigation } from "./LegacyAnchorRedirect"
import { LEGACY_ANCHORS, legacyRedirectsFor, resolveLegacyHash } from "./legacy-anchors"

const router = { replace: vi.spyOn(legacyNavigation, "go").mockImplementation(() => undefined) }
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
  window.history.replaceState(null, "", "/")
  router.replace.mockClear()
})

async function mount(href: string) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LegacyAnchorRedirect redirects={legacyRedirectsFor(href)} />))
}

describe("legacy anchor redirects", () => {
  it("renders every redirecting legacy id on its old docs page", () => {
    const paths = new Set(
      LEGACY_ANCHORS.filter(({ mode }) => mode === "redirect").map(
        ({ legacyHref }) => legacyHref.split("#")[0] ?? "",
      ),
    )
    expect(paths.size).toBeGreaterThan(0)
    for (const path of paths) {
      const html = renderToStaticMarkup(<DocsPage href={path} Content={() => <p>content</p>} />)
      for (const { id } of legacyRedirectsFor(path)) {
        expect(html, `${path}#${id}`).toContain(`id="${id}"`)
      }
    }
  })

  it("renders nothing on a page without legacy ids", () => {
    expect(legacyRedirectsFor("/docs/getting-started")).toEqual([])
    expect(renderToStaticMarkup(<LegacyAnchorRedirect redirects={[]} />)).toBe("")
  })

  it("resolves only mapped redirect fragments", () => {
    const redirects = legacyRedirectsFor("/docs/memory")
    expect(resolveLegacyHash("#generated-tools", redirects)).toBe(
      "/docs/memory/long-term#generated-recall-and-remember-tools",
    )
    expect(resolveLegacyHash("generated-tools", redirects)).toBe(
      "/docs/memory/long-term#generated-recall-and-remember-tools",
    )
    expect(resolveLegacyHash("#%67enerated-tools", redirects)).toBe(
      "/docs/memory/long-term#generated-recall-and-remember-tools",
    )
    // A retained section stays on the page.
    expect(resolveLegacyHash("#updating-it", redirects)).toBeUndefined()
    expect(resolveLegacyHash("#route-memory-memorymd", redirects)).toBeUndefined()
    expect(resolveLegacyHash("", redirects)).toBeUndefined()
    expect(resolveLegacyHash("#%E0%A4%A", redirects)).toBeUndefined()
  })

  it("replaces a legacy hash on load and on hashchange", async () => {
    window.history.replaceState(null, "", "/docs/memory#how-recall-ranks")
    await mount("/docs/memory")
    expect(router.replace).toHaveBeenCalledExactlyOnceWith(
      "/docs/memory/retrieval#how-recall-ranks",
    )

    router.replace.mockClear()
    window.location.hash = "#cost"
    await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")))
    expect(router.replace).toHaveBeenCalledWith("/docs/memory/distillation#cost")
  })

  it("leaves current fragments alone", async () => {
    window.history.replaceState(null, "", "/docs/memory#updating-it")
    await mount("/docs/memory")
    await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")))
    expect(router.replace).not.toHaveBeenCalled()
  })
})
