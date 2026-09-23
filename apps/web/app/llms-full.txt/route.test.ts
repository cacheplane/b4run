import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { webContentRoot } from "../../lib/content-root"
import { llmsDocSection } from "../../lib/llms-markdown.mjs"
import { ALL_DOCS_PAGES } from "../components/docs/nav"
import { dynamic, GET } from "./route"

const CONTENT_ROOT = webContentRoot()
const FINAL_PR2_API_HREFS = [
  "/docs/api/permissions",
  "/docs/api/workspace",
  "/docs/api/sandbox",
  "/docs/api/langgraph",
  "/docs/api/langchain",
  "/docs/api/sqlite-storage",
] as const
// Every MDX component the docs and blog render. None may leak into the text.
const MDX_COMPONENTS = [
  "Callout",
  "RelatedCards",
  "CodeGroup",
  "Steps",
  "Step",
  "Tabs",
  "Tab",
  "CopyPromptButton",
] as const

function sourceFor(href: string): string {
  const slug = href.replace(/^\/docs\//, "")
  const file = slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`
  return readFileSync(join(CONTENT_ROOT, "docs", file), "utf8")
}

/** Lines outside fenced code blocks. */
function proseLines(text: string): string[] {
  const lines: string[] = []
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/)?.[1]
    if (marker !== undefined && fence === undefined) {
      fence = marker
      continue
    }
    if (marker !== undefined && fence !== undefined) {
      // A fence closes only on a bare run of its own character at least as long.
      if (line.trim() === marker && marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined
      continue
    }
    if (fence === undefined) lines.push(line)
  }
  return lines
}

async function body(): Promise<string> {
  return (await GET()).text()
}

function between(text: string, start: string, end: string): string {
  return text.slice(text.indexOf(start), text.indexOf(end))
}

describe("full LLM documentation route", () => {
  it("is rendered at build time instead of on every request", () => {
    expect(dynamic).toBe("force-static")
  })

  it("includes every registered page exactly once and in exhaustive registry order", async () => {
    const documentation = between(await body(), "## Documentation", "## Task-Specific Prompts")
    const positions = ALL_DOCS_PAGES.map((page) => {
      const section = llmsDocSection(page, sourceFor(page.href))
      const position = documentation.indexOf(section)

      expect(position, page.href).toBeGreaterThanOrEqual(0)
      expect(documentation.lastIndexOf(section), page.href).toBe(position)
      expect(section, page.href).toContain(`Source: https://b4.run${page.href}\n`)
      return position
    })

    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(documentation).toContain("### Thread Access\n")
    for (const href of FINAL_PR2_API_HREFS) {
      const page = ALL_DOCS_PAGES.find((candidate) => candidate.href === href)
      expect(page, href).toBeDefined()
      expect(documentation).toContain(`### ${page?.label}\n`)
    }
  })

  it("loads the recipes landing page and nested recipe from their authored files", async () => {
    const documentation = between(await body(), "## Documentation", "## Task-Specific Prompts")

    for (const href of ["/docs/recipes", "/docs/recipes/add-a-tool", "/docs/memory/long-term"]) {
      const page = ALL_DOCS_PAGES.find((candidate) => candidate.href === href)
      expect(page, href).toBeDefined()
      if (page !== undefined) expect(documentation).toContain(llmsDocSection(page, sourceFor(href)))
    }
  })

  it("leaks no MDX components outside code blocks", async () => {
    const prose = proseLines(await body()).join("\n")
    for (const name of MDX_COMPONENTS) {
      expect(prose, name).not.toMatch(new RegExp(`</?${name}\\b`))
    }
    expect(prose).not.toMatch(/^\s*import\s.+\sfrom\s+["']/m)
    expect(prose).not.toContain("{/*")
    expect(prose).not.toMatch(/\]\(\/(?!\/)/)
  })

  it("nests every heading under the file, part, and page outline", async () => {
    const lines = proseLines(await body())
    const headings = lines.filter((line) => /^#{1,6}\s/.test(line))
    expect(headings.filter((line) => line.startsWith("# "))).toEqual(["# B4.run: Full Reference"])
    expect(headings.filter((line) => line.startsWith("## "))).toEqual([
      "## Brand Assets",
      "## Documentation",
      "## Task-Specific Prompts",
      "## Agent Config Templates",
      "## Historical Blog Archive",
    ])

    const documentation = between(lines.join("\n"), "## Documentation", "## Task-Specific Prompts")
    const pageHeadings = documentation.split("\n").filter((line) => line.startsWith("### "))
    expect(pageHeadings).toEqual(ALL_DOCS_PAGES.map((page) => `### ${page.label}`))
  })

  it("keeps the agent config template verbatim inside a fence", async () => {
    const templates = between(
      await body(),
      "## Agent Config Templates",
      "## Historical Blog Archive",
    )
    const template = readFileSync(join(CONTENT_ROOT, "templates/AGENTS.md"), "utf8")
    expect(templates).toContain(`\`\`\`\`markdown\n${template.replace(/\n+$/, "")}\n\`\`\`\``)
  })

  it("marks the blog archive historical and gives each post its source URL", async () => {
    const text = await body()
    const archive = text.slice(text.indexOf("## Historical Blog Archive"))
    expect(archive).toContain("historical, non-normative")
    expect(archive).toMatch(/^### .+\n\nSource: https:\/\/b4\.run\/blog\/[a-z0-9-]+\nPublished: /m)
    expect(proseLines(archive).join("\n")).not.toMatch(/^---\ntitle:/m)
  })
})
