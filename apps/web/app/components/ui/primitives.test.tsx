import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Button } from "./Button"
import { Card } from "./Card"
import { CopyCommand } from "./CopyCommand"
import { Eyebrow } from "./Eyebrow"
import { ICON_NAMES, Icon } from "./Icon"
import { SiteLink } from "./SiteLink"

describe("primitives", () => {
  it("Eyebrow renders a data-ui paragraph with a tone", () => {
    expect(renderToStaticMarkup(<Eyebrow>Docs</Eyebrow>)).toBe(
      '<p data-ui="eyebrow" data-tone="muted">Docs</p>',
    )
    expect(renderToStaticMarkup(<Eyebrow tone="olive">Blog</Eyebrow>)).toContain(
      'data-tone="olive"',
    )
    expect(renderToStaticMarkup(<Eyebrow tone="panel">Panel</Eyebrow>)).toBe(
      '<p data-ui="eyebrow" data-tone="panel">Panel</p>',
    )
  })

  it("Eyebrow renders a span when asked, for places a <p> is invalid", () => {
    expect(renderToStaticMarkup(<Eyebrow as="span">On this page</Eyebrow>)).toBe(
      '<span data-ui="eyebrow" data-tone="muted">On this page</span>',
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

  it("Button forwards button attributes and lets type override the default", () => {
    const html = renderToStaticMarkup(
      <Button aria-label="Save" disabled type="submit">
        Save
      </Button>,
    )
    expect(html).toMatch(/^<button [^>]*type="submit"/)
    expect(html).not.toContain('type="button"')
    expect(html).toContain('aria-label="Save"')
    expect(html).toMatch(/<button[^>]* disabled(="")?[ >]/)
  })

  it("Button href forwards anchor attributes", () => {
    const html = renderToStaticMarkup(
      <Button href="/blueprint.md" download aria-label="Download the blueprint">
        Get
      </Button>,
    )
    expect(html).toMatch(/^<a /)
    expect(html).toMatch(/<a[^>]* download(="")?[ >]/)
    expect(html).toContain('aria-label="Download the blueprint"')
  })

  it("Button and SiteLink forward onClick in both branches", () => {
    const onClick = () => {}
    expect(
      (Button({ children: "x", onClick }) as { props: { onClick?: unknown } }).props.onClick,
    ).toBe(onClick)
    expect(
      (Button({ href: "/x", children: "x", onClick }) as { props: { onClick?: unknown } }).props
        .onClick,
    ).toBe(onClick)
    expect(
      (SiteLink({ href: "/x", children: "x", onClick }) as { props: { onClick?: unknown } }).props
        .onClick,
    ).toBe(onClick)
    expect(
      (
        SiteLink({ href: "https://x.test", children: "x", onClick }) as {
          props: { onClick?: unknown }
        }
      ).props.onClick,
    ).toBe(onClick)
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

  it("SiteLink forwards className and aria-current", () => {
    const html = renderToStaticMarkup(
      <SiteLink href="/docs" className="nav" aria-current="page">
        Docs
      </SiteLink>,
    )
    expect(html).toContain('class="nav"')
    expect(html).toContain('aria-current="page"')
  })

  it("SiteLink lets a caller target win over _blank and forces a plain anchor", () => {
    const self = renderToStaticMarkup(
      <SiteLink href="https://example.com" target="_self">
        Same tab
      </SiteLink>,
    )
    expect(self).toContain('target="_self"')
    expect(self).not.toContain('target="_blank"')
    const file = renderToStaticMarkup(
      <SiteLink href="/llms.txt" target="_blank">
        llms.txt
      </SiteLink>,
    )
    expect(file).toBe('<a href="/llms.txt" target="_blank">llms.txt</a>')
    expect(
      (SiteLink({ href: "/llms.txt", target: "_blank", children: "x" }) as { type: unknown }).type,
    ).toBe("a")
  })

  it("SiteLink renders mailto: as a plain anchor with no target", () => {
    const html = renderToStaticMarkup(<SiteLink href="mailto:hi@b4.run">Email</SiteLink>)
    expect(html).toBe('<a href="mailto:hi@b4.run">Email</a>')
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

  it("every Icon name renders a glyph", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(0)
    for (const name of ICON_NAMES) {
      const inner = /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(renderToStaticMarkup(<Icon name={name} />))
      expect(inner?.[1], name).toMatch(/^<(rect|path|polyline|circle|line)\b/)
    }
  })

  it("CopyCommand renders the light variant by default and the dark one on request", () => {
    const light = renderToStaticMarkup(<CopyCommand command="npm create b4-app@latest" />)
    expect(light).toMatch(/^<div data-ui="copy-command" data-variant="light"/)
    expect(light).toContain("<span>$</span> npm create b4-app@latest")
    expect(light).toContain('aria-label="Copy command: npm create b4-app@latest"')
    expect(renderToStaticMarkup(<CopyCommand command="x" variant="dark" />)).toContain(
      'data-variant="dark"',
    )
  })
})
