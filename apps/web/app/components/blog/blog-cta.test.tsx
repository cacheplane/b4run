import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { BlogCta } from "./BlogCta"

it("sends readers to Getting Started, not the code-fixer walkthrough", () => {
  const html = renderToStaticMarkup(<BlogCta />)
  expect(html).toContain('href="/docs/getting-started"')
  expect(html).toContain("npm create b4-app@latest my-agent")
  expect(html).not.toMatch(/walkthrough|code-fixer/i)
})
