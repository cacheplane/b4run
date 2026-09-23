import { compile } from "@mdx-js/mdx"
import { describe, expect, it } from "vitest"
import { SHIKI_FOREGROUNDS } from "../../../lib/design-tokens"
import { MDX_REHYPE_PLUGINS } from "../../../lib/mdx-plugins"
import {
  SYNTAX_CLASSES,
  SYNTAX_FOREGROUNDS,
  syntaxClassesFor,
  syntaxStylesheet,
} from "../../../lib/shiki-classes"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"

async function compileWithSitePlugins(source: string): Promise<string> {
  const plugins = await Promise.all(
    MDX_REHYPE_PLUGINS.map(async ([name, options]) => [(await import(name)).default, options]),
  )
  return String(await compile(source, { rehypePlugins: plugins as never }))
}

describe("shared syntax output", () => {
  it("emits one dark palette as classes and keeps code and heading anchors", async () => {
    const compiled = await compileWithSitePlugins(
      '# Example\n\n```ts\n// greeting\nconst message: string = "hello"\nexport function greet() {}\n```\n\n```md\n**bold** text\n```\n\n```diff\n+added\n-removed\n```\n\nInline `const x = 1{:ts}`.',
    )
    expect(compiled).not.toContain("--shiki-light")
    expect(compiled).not.toContain("--shiki-dark")
    // compile() renders attributes as JSX props: `className: "sh1"`, `style: {…}`.
    const cls = (declaration: string) => `className: "${SYNTAX_CLASSES[declaration]}"`
    expect(compiled).toContain(cls("color:#c5d985")) // keyword
    expect(compiled).toContain(cls("color:#e5cb9b")) // string
    expect(compiled).toContain(cls("color:#a3aa99")) // comment
    expect(compiled).toContain(cls("color:#a8d4e0")) // type
    expect(compiled).toContain(`${SYNTAX_CLASSES["font-weight:bold"]}"`) // markdown bold
    // No token keeps an inline style; only rehype-pretty-code's `display: grid` on <code>.
    expect(compiled).not.toMatch(/color: "#/i)
    expect(compiled).not.toMatch(/fontWeight|fontStyle|textDecoration/)
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

describe("syntax classes", () => {
  it("give every theme foreground a class", () => {
    for (const hex of SHIKI_FOREGROUNDS) expect(SYNTAX_FOREGROUNDS).toContain(hex)
    expect(syntaxClassesFor("color:#C5D985;font-weight:bold")).toEqual([
      SYNTAX_CLASSES["color:#c5d985"],
      SYNTAX_CLASSES["font-weight:bold"],
    ])
  })

  it("keep an inline style they cannot represent", () => {
    expect(syntaxClassesFor("color:#123456")).toBeUndefined()
    expect(syntaxClassesFor("color:#c5d985;text-decoration:underline line-through")).toBeUndefined()
  })

  it("match the generated stylesheet (update with -u after a theme change)", async () => {
    await expect(syntaxStylesheet()).toMatchFileSnapshot("../../styles/syntax.css")
  })
})
