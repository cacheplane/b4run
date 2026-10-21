import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { Footer } from "./Footer"
import { NAVLOG_DEMO_URL } from "./site-links"

const anchor = (html: string, href: string) => {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`<a [^>]*href="${escaped}"[^>]*>`).exec(html)
  expect(match, href).not.toBeNull()
  return match?.[0] ?? ""
}

it("opens same-origin files in a new tab as plain anchors, off-site links with rel, internal links in place", () => {
  const html = renderToStaticMarkup(<Footer />)
  // `target` on SiteLink forces a plain <a> (see primitives.test.tsx), so the
  // client router never intercepts these file URLs.
  for (const href of ["/blog/rss.xml", "/llms.txt"]) {
    const tag = anchor(html, href)
    expect(tag).toContain('target="_blank"')
    expect(tag).not.toContain("rel=")
  }
  const github = anchor(html, "https://github.com/cacheplane/b4run")
  expect(github).toContain('target="_blank"')
  expect(github).toContain('rel="noopener noreferrer"')
  for (const href of ["/docs/getting-started", "/blog", "/privacy"]) {
    const tag = anchor(html, href)
    expect(tag).not.toContain("target=")
    expect(tag).not.toContain("rel=")
  }
  expect(html).not.toContain("↗")
})

it("no longer links the code-fixer walkthrough, which left the homepage", () => {
  const html = renderToStaticMarkup(<Footer />)
  expect(html).not.toMatch(/walkthrough|code-fixer/i)
})

it("tags its calls to action and marks the footer surface", () => {
  const html = renderToStaticMarkup(<Footer />)
  expect(html).toContain('data-signal-surface="footer"')
  const cases: [string, string][] = [
    ["https://github.com/cacheplane/b4run", "footer_github"],
    ["https://www.npmjs.com/org/b4run", "footer_npm"],
    [NAVLOG_DEMO_URL, "footer_live_demo"],
    ["/blog/rss.xml", "footer_rss"],
  ]
  for (const [href, id] of cases) expect(anchor(html, href)).toContain(`data-cta-id="${id}"`)
})
