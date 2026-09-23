import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CodeGroup } from "./CodeGroup"
import { Step, Steps } from "./Steps"
import { Tab, Tabs } from "./Tabs"

describe("MDX hooks the CSS keys off", () => {
  it("Steps renders an ordered list with a number span directly inside each item", () => {
    const html = renderToStaticMarkup(
      <Steps>
        <Step title="Install">Run the installer.</Step>
        <Step title="Run">Start the dev server.</Step>
      </Steps>,
    )
    expect(html).toMatch(/^<ol data-prose-steps/)
    expect(html).toMatch(/<li[^>]*><span[^>]*>1<\/span>/)
    expect(html).toMatch(/<li[^>]*><span[^>]*>2<\/span>/)
    expect(html.match(/<li/g)).toHaveLength(2)
  })

  it("Tabs renders a tablist with exactly one selected tab", () => {
    const html = renderToStaticMarkup(
      <Tabs>
        <Tab label="npm">npm install</Tab>
        <Tab label="pnpm">pnpm add</Tab>
      </Tabs>,
    )
    expect(html).toMatch(/^<div data-prose-tabs/)
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toContain("npm install")
    expect(html).not.toContain("pnpm add")
  })

  it("CodeGroup renders the frame and header, and only the active <pre>", () => {
    const html = renderToStaticMarkup(
      <CodeGroup>
        <pre data-language="ts">
          <code>const a = 1</code>
        </pre>
        <pre data-language="js">
          <code>var a = 1</code>
        </pre>
      </CodeGroup>,
    )
    expect(html).toMatch(/^<div data-code-frame/)
    expect(html).toContain("data-code-header")
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html.match(/<pre/g)).toHaveLength(1)
    expect(html).toContain("const a = 1")
    expect(html).not.toContain("var a = 1")
  })
})
