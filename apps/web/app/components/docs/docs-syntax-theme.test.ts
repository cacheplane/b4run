import { compile } from "@mdx-js/mdx"
import { describe, expect, it } from "vitest"
import { SHIKI_FOREGROUNDS } from "../../../lib/design-tokens"
import { MDX_REHYPE_PLUGINS } from "../../../lib/mdx-plugins"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"

describe("shared syntax output", () => {
  it("emits one dark palette inline and keeps code and heading anchors", async () => {
    const plugins = await Promise.all(
      MDX_REHYPE_PLUGINS.map(async ([name, options]) => [(await import(name)).default, options]),
    )
    const compiled = String(
      await compile(
        '# Example\n\n```ts\n// greeting\nconst message: string = "hello"\nexport function greet() {}\n```',
        { rehypePlugins: plugins as never },
      ),
    )
    expect(compiled).not.toContain("--shiki-light")
    expect(compiled).not.toContain("--shiki-dark")
    // compile() renders `style` attributes as JSX object literals
    // (`color: "#C5D985"`), not raw `style="color:#hex"` HTML text, so match
    // the hex value case-insensitively rather than an exact "color:#hex" run.
    const lower = compiled.toLowerCase()
    expect(lower).toContain("#c5d985") // keyword
    expect(lower).toContain("#e5cb9b") // string
    expect(lower).toContain("#a3aa99") // comment
    expect(lower).toContain("#a8d4e0") // type
    expect(compiled).toContain('id: "example"')
    expect(compiled).toContain("greeting")
    expect(compiled).toContain("hello")
  })

  it("only uses foregrounds the contrast test covers", () => {
    const used = new Set<string>([PAPER_RELAY_THEME.colors["editor.foreground"]])
    for (const rule of PAPER_RELAY_THEME.settings) used.add(rule.settings.foreground.toLowerCase())
    for (const hex of used) expect(SHIKI_FOREGROUNDS).toContain(hex)
  })
})
