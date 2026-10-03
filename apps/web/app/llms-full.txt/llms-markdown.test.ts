import { describe, expect, it } from "vitest"
import { fencedVerbatim, llmsDocSection, mdxToMarkdown } from "../../lib/llms-markdown.mjs"

describe("mdxToMarkdown", () => {
  it("turns a Callout into a labelled blockquote with absolute links", () => {
    const source = [
      "Intro.",
      "",
      '<Callout type="warn" title="Mind the edge">',
      "  Protect the service. See [Security](/docs/security-architecture).",
      "",
      "  Second paragraph.",
      "</Callout>",
      "",
      "After.",
    ].join("\n")

    expect(mdxToMarkdown(source)).toBe(
      [
        "Intro.",
        "",
        "> **Warning: Mind the edge**",
        ">",
        "> Protect the service. See [Security](https://b4.run/docs/security-architecture).",
        ">",
        "> Second paragraph.",
        "",
        "After.",
      ].join("\n"),
    )
  })

  it("labels an untitled Callout with its type, defaulting to Info", () => {
    expect(mdxToMarkdown("<Callout>\n  Body.\n</Callout>")).toBe("> **Info**\n>\n> Body.")
    expect(mdxToMarkdown('<Callout type="tip">\n  Body.\n</Callout>')).toBe("> **Tip**\n>\n> Body.")
  })

  it("turns RelatedCards into a Related link list", () => {
    const source = [
      "Text.",
      "",
      "<RelatedCards",
      "  items={[",
      '    { href: "/docs/tools", title: "Tools", subtitle: "tool scoping" },',
      '    { href: "/docs/sandbox", title: "Sandbox", description: "isolation" },',
      "  ]}",
      "/>",
    ].join("\n")

    expect(mdxToMarkdown(source)).toBe(
      [
        "Text.",
        "",
        "Related:",
        "",
        "- [Tools](https://b4.run/docs/tools): tool scoping",
        "- [Sandbox](https://b4.run/docs/sandbox): isolation",
      ].join("\n"),
    )
  })

  it("omits the Related label directly under a heading", () => {
    const source =
      '## Related\n\n<RelatedCards items={[\n  { href: "/docs/agents", title: "Agents" },\n]} />'
    expect(mdxToMarkdown(source)).toBe("## Related\n\n- [Agents](https://b4.run/docs/agents)")
  })

  it("unwraps CodeGroup into sequential captioned code blocks", () => {
    const source = [
      "<CodeGroup>",
      '```ts title="src/app/a/index.ts"',
      'export default agent({ model: "gpt-5-mini" })',
      "```",
      "",
      '```ts title="src/app/a/tools/b.ts" showLineNumbers',
      "export default async () => 1",
      "```",
      "</CodeGroup>",
    ].join("\n")

    expect(mdxToMarkdown(source)).toBe(
      [
        "`src/app/a/index.ts`:",
        "",
        "```ts",
        'export default agent({ model: "gpt-5-mini" })',
        "```",
        "",
        "`src/app/a/tools/b.ts`:",
        "",
        "```ts",
        "export default async () => 1",
        "```",
      ].join("\n"),
    )
  })

  it("numbers Steps as sub-headings below the current section", () => {
    const source = [
      "## Run it",
      "",
      "<Steps>",
      '<Step title="Configure">',
      "Set the key.",
      "</Step>",
      '<Step title="Start">',
      "Run dev.",
      "</Step>",
      "</Steps>",
    ].join("\n")

    expect(mdxToMarkdown(source, { headingOffset: 2 })).toBe(
      [
        "#### Run it",
        "",
        "##### Step 1: Configure",
        "Set the key.",
        "##### Step 2: Start",
        "Run dev.",
      ].join("\n"),
    )
  })

  it("turns Tabs into labelled sub-headings", () => {
    const source =
      '## Install\n<Tabs>\n<Tab label="npm">\nnpm i\n</Tab>\n<Tab label="pnpm">\npnpm add\n</Tab>\n</Tabs>'
    expect(mdxToMarkdown(source)).toBe("## Install\n### npm\nnpm i\n### pnpm\npnpm add")
  })

  it("turns CopyPromptButton into a prompt link", () => {
    expect(
      mdxToMarkdown('<CopyPromptButton variant="docs" label="Copy" promptSlug="scaffold" />'),
    ).toBe("Copy-ready prompt: https://b4.run/prompts/scaffold")
  })

  it("leaves code fences, inline code, and non-root links untouched", () => {
    const source = [
      "Use `[x](/docs/memory)` and [ext](https://example.com) and [anchor](#here).",
      "",
      "```tsx",
      "<Callout>not a component here</Callout>",
      "# not a heading",
      "[link](/docs/state)",
      "```",
    ].join("\n")

    expect(mdxToMarkdown(source, { dropTitle: true, headingOffset: 2 })).toBe(source)
  })

  it("drops the leading title and shifts headings, capped at H6", () => {
    const source = "# Page\n\nIntro.\n\n## Section\n\n### Sub\n\n#### Deep\n\n##### Deeper"
    expect(mdxToMarkdown(source, { dropTitle: true, headingOffset: 2 })).toBe(
      "Intro.\n\n#### Section\n\n##### Sub\n\n###### Deep\n\n###### Deeper",
    )
  })

  it("keeps a later H1 when the document does not open with one", () => {
    expect(mdxToMarkdown("Intro.\n\n# Later", { dropTitle: true, headingOffset: 2 })).toBe(
      "Intro.\n\n### Later",
    )
  })

  it("strips frontmatter, MDX comments, and ESM imports", () => {
    const source =
      '---\ntitle: "Post"\ndate: 2026-01-01\n---\n{/* GENERATED. Do not edit. */}\nimport { X } from "y"\n\nBody.'
    expect(mdxToMarkdown(source)).toBe("Body.")
  })
})

describe("llmsDocSection", () => {
  it("replaces the page title with a section heading and canonical URL", () => {
    expect(
      llmsDocSection({ label: "Tools", href: "/docs/tools" }, "# Tools\n\nText.\n\n## Scoping\n"),
    ).toBe("### Tools\n\nSource: https://b4.run/docs/tools\n\nText.\n\n#### Scoping")
  })
})

describe("fencedVerbatim", () => {
  it("uses a fence longer than any fence inside the content", () => {
    expect(fencedVerbatim("# T\n\n```ts\nx\n```\n", "markdown")).toBe(
      "````markdown\n# T\n\n```ts\nx\n```\n````",
    )
  })
})
