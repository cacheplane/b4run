import { compile } from "@mdx-js/mdx"
import { describe, expect, it } from "vitest"
import { MDX_REHYPE_PLUGINS } from "../../../lib/mdx-plugins"

describe("shared syntax output", () => {
  it("provides both palettes without changing code or heading anchors", async () => {
    const plugins = await Promise.all(
      MDX_REHYPE_PLUGINS.map(async ([name, options]) => [(await import(name)).default, options]),
    )
    const compiled = String(
      await compile('# Example\n\n```ts\n// greeting\nconst message = "hello"\n```', {
        rehypePlugins: plugins as never,
      }),
    )
    expect(compiled).toContain("--shiki-light")
    expect(compiled).toContain("--shiki-dark")
    expect(compiled).toContain('id: "example"')
    expect(compiled).toContain("greeting")
    expect(compiled).toContain("message")
    expect(compiled).toContain("hello")
  })
})
