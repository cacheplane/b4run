import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

// Aliased: MDX requires the hook name, but this is a plain factory.
import { useMDXComponents as buildMdxComponents } from "../../../mdx-components"

const components = buildMdxComponents({})

/** Renders the MDX override for `tag` the way the page would, with a slug id. */
function render(tag: string): string {
  const Heading = components[tag as keyof typeof components]
  if (typeof Heading !== "function") throw new Error(`no MDX override for <${tag}>`)
  return renderToStaticMarkup(
    createElement(Heading as never, { id: "a-heading-slug" }, "A heading"),
  )
}

describe("MDX heading overrides", () => {
  // rehype-slug puts the id on the heading; these overrides render it. Dropping
  // the prop silently strips every anchor target off the page.
  it.each(["h1", "h2", "h3", "h4"])("keeps the build-assigned id on <%s>", (tag) => {
    const html = render(tag)
    expect(html).toContain('id="a-heading-slug"')
    expect(html).toContain("A heading")
    expect(html).toMatch(new RegExp(`^<${tag}[ >]`))
  })
})

describe("heading self-links", () => {
  it.each(["h2", "h3"])("adds a labelled copy-link to <%s> without changing its id", (tag) => {
    const html = render(tag)
    expect(html).toMatch(new RegExp(`^<${tag} id="a-heading-slug"`))
    expect(html).toMatch(/<a href="#a-heading-slug"[^>]*>[\s\S]*Copy link to section: A heading/)
    expect(html).toContain('role="status"')
  })

  it.each(["h1", "h4"])("leaves <%s> without a self-link", (tag) => {
    expect(render(tag)).not.toContain("data-heading-anchor")
  })
})
