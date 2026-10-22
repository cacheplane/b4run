import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { NAVLOG_DEMO_URL } from "./site-links"

async function loadFooter(enabled: boolean) {
  vi.resetModules()
  vi.doMock("../lib/growth/updates-enabled", () => ({ UPDATES_FORM_ENABLED: enabled }))
  return (await import("./Footer")).Footer
}

afterEach(() => vi.doUnmock("../lib/growth/updates-enabled"))

/**
 * The opening `<a …>` tag whose href is exactly `href`. Plain string search
 * rather than a RegExp built from the href: a hostname in a pattern reads as
 * an incomplete hostname check to static analysis, and nothing here needs
 * pattern matching.
 */
const anchor = (html: string, href: string) => {
  const at = html.indexOf(`href="${href}"`)
  expect(at, href).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf("<a ", at)
  const end = html.indexOf(">", at)
  expect(start, href).toBeGreaterThanOrEqual(0)
  expect(end, href).toBeGreaterThan(start)
  return html.slice(start, end + 1)
}

it("opens same-origin files in a new tab as plain anchors, off-site links with rel, internal links in place", async () => {
  const Footer = await loadFooter(true)
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

it("no longer links the code-fixer walkthrough, which left the homepage", async () => {
  const Footer = await loadFooter(true)
  const html = renderToStaticMarkup(<Footer />)
  expect(html).not.toMatch(/walkthrough|code-fixer/i)
})

it("tags its calls to action and marks the footer surface", async () => {
  const Footer = await loadFooter(true)
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

it("links Updates in the Product column with its call-to-action id when the form is enabled", async () => {
  const Footer = await loadFooter(true)
  const tag = anchor(renderToStaticMarkup(<Footer />), "/updates")
  expect(tag).toContain('data-cta-id="footer_updates"')
})

it("omits the Updates link when the form is not enabled", async () => {
  const Footer = await loadFooter(false)
  const html = renderToStaticMarkup(<Footer />)
  expect(html).not.toContain('href="/updates"')
  expect(html).not.toContain("footer_updates")
  expect(html).toContain('href="/blog"')
})
