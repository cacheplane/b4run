import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { Footer } from "./Footer"

const anchor = (html: string, href: string) => {
  const match = new RegExp(`<a [^>]*href="${href.replace(/[.]/g, "\\.")}"[^>]*>`).exec(html)
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
  for (const href of ["/docs/getting-started", "/blog"]) {
    const tag = anchor(html, href)
    expect(tag).not.toContain("target=")
    expect(tag).not.toContain("rel=")
  }
  expect(html).not.toContain("↗")
})
