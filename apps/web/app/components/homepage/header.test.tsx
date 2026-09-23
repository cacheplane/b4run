// @vitest-environment jsdom
import { renderToString } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { HeaderInner } from "../HeaderInner"

const location = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push: vi.fn() }),
}))
it("renders the same header, with the install command, on every page", () => {
  const render = (pathname: string) => {
    location.pathname = pathname
    return renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
  }
  const home = render("/")
  expect(home).not.toContain("Get the blueprint")
  expect(home).toContain("npm create b4-app@latest my-agent")
  expect(home).toContain("/docs/getting-started")
  // Only the active-link state and the column the bar aligns to (data-layout)
  // differ between pages. Compare the visible bar only; the mobile menu adds
  // the docs nav on docs pages.
  const strip = (html: string) =>
    html
      .split("<dialog")[0]
      ?.replace(/<button[^>]*data-header-docs-search[\s\S]*?<\/button>/, "")
      .replace(/text-ink(-muted hover:text-ink)? transition-colors/g, "")
      .replace(/ data-layout="[a-z]+"/, "")
  expect(strip(render("/docs/getting-started"))).toBe(strip(home))
  expect(strip(render("/blog"))).toBe(strip(home))
})

it("aligns the header with each page's column", () => {
  const layout = (pathname: string) => {
    location.pathname = pathname
    const html = renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
    return /data-layout="([a-z]+)"/.exec(html)?.[1]
  }
  expect(layout("/")).toBe("home")
  expect(layout("/blog")).toBe("site")
  expect(layout("/blog/tags/agents")).toBe("site")
  expect(layout("/blog/why-we-built-b4")).toBe("reading")
  expect(layout("/docs/getting-started")).toBe("reading")
})

it("labels the main nav and offers docs search on every page", () => {
  const render = (pathname: string) => {
    location.pathname = pathname
    return renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
  }
  const docs = render("/docs/tools")
  expect(docs).toContain('aria-label="Main"')
  expect(docs).toMatch(
    /<button(?=[^>]*data-mobile-docs-search)(?=[^>]*aria-label="Search docs")(?=[^>]*md:hidden)(?=[^>]*data-ui="icon-button")/,
  )
  for (const pathname of ["/", "/blog"]) {
    const html = render(pathname)
    expect(html).toContain("data-mobile-docs-search")
    // Pages without the docs sidebar get the desktop search button instead.
    expect(html).toMatch(/<button(?=[^>]*data-header-docs-search)(?=[^>]*aria-haspopup="dialog")/)
    expect(html).toContain("data-docs-search-dialog")
  }
  expect(docs).not.toContain("data-header-docs-search")
})

it("suppresses the ↗ on the desktop GitHub icon link", () => {
  location.pathname = "/"
  const html = renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
  expect(html).toMatch(
    /<a[^>]*data-no-arrow[^>]*aria-label="GitHub"|<a[^>]*aria-label="GitHub"[^>]*data-no-arrow/,
  )
})
