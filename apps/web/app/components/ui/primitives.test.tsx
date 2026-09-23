import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Button } from "./Button"
import { Card } from "./Card"
import { CopyCommand } from "./CopyCommand"
import { Eyebrow } from "./Eyebrow"
import { Icon } from "./Icon"
import { SiteLink } from "./SiteLink"

describe("primitives", () => {
  it("Eyebrow renders a data-ui paragraph with a tone", () => {
    expect(renderToStaticMarkup(<Eyebrow>Docs</Eyebrow>)).toBe(
      '<p data-ui="eyebrow" data-tone="muted">Docs</p>',
    )
    expect(renderToStaticMarkup(<Eyebrow tone="olive">Blog</Eyebrow>)).toContain(
      'data-tone="olive"',
    )
  })

  it("Button is a <button> without href and an <a> with one", () => {
    const button = renderToStaticMarkup(<Button>Go</Button>)
    expect(button).toMatch(/^<button [^>]*type="button"/)
    expect(button).toContain('data-ui="button" data-variant="primary"')
    const link = renderToStaticMarkup(
      <Button href="/docs" variant="secondary" size="sm">
        Go
      </Button>,
    )
    expect(link).toMatch(/^<a /)
    expect(link).toContain('data-ui="button" data-variant="secondary" data-size="sm"')
    expect(link).toContain('href="/docs"')
  })

  it("SiteLink opens off-site hrefs in a new tab and never writes the arrow itself", () => {
    const external = renderToStaticMarkup(
      <SiteLink href="https://github.com/cacheplane/b4run">GitHub</SiteLink>,
    )
    expect(external).toBe(
      '<a href="https://github.com/cacheplane/b4run" target="_blank" rel="noopener noreferrer">GitHub</a>',
    )
    const internal = renderToStaticMarkup(<SiteLink href="/docs/agents">Agents</SiteLink>)
    expect(internal).toBe('<a href="/docs/agents">Agents</a>')
    expect(external + internal).not.toContain("↗")
  })

  it("Card is a link when given an href", () => {
    const link = renderToStaticMarkup(<Card href="/x">x</Card>)
    expect(link).toMatch(/^<a /)
    expect(link).toContain('data-ui="card"')
    expect(link).toContain('href="/x"')
    expect(renderToStaticMarkup(<Card>x</Card>)).toBe('<div data-ui="card">x</div>')
  })

  it("Icon renders a 24-grid svg with a size", () => {
    const html = renderToStaticMarkup(<Icon name="copy" />)
    expect(html).toMatch(
      /^<svg data-ui="icon" data-size="sm" viewBox="0 0 24 24" aria-hidden="true"/,
    )
    expect(renderToStaticMarkup(<Icon name="close" size="md" />)).toContain('data-size="md"')
  })

  it("CopyCommand renders the light variant by default and the dark one on request", () => {
    const light = renderToStaticMarkup(<CopyCommand command="npm create b4-app@latest" />)
    expect(light).toMatch(/^<div data-ui="copy-command" data-variant="light"/)
    expect(light).toContain("<span>$</span> npm create b4-app@latest")
    expect(light).toContain('aria-label="Copy command: npm create b4-app@latest"')
    expect(renderToStaticMarkup(<CopyCommand command="x" variant="dark" />)).toContain(
      'data-variant="dark"',
    )
    expect(light).not.toMatch(/rounded|accent-saas/)
  })
})
