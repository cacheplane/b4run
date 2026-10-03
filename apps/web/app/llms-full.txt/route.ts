import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path, { join } from "node:path"
import { NextResponse } from "next/server"
import { PROMPTS } from "../../content/prompts"
import { webContentRoot } from "../../lib/content-root"
import { fencedVerbatim, llmsDocSection, mdxToMarkdown } from "../../lib/llms-markdown.mjs"
import { getAllPosts } from "../components/blog/post-index"
import { ALL_DOCS_PAGES } from "../components/docs/nav"

// Rendered once at build time and served from the CDN. The content is baked
// into every deploy, so there is nothing to recompute per request.
export const dynamic = "force-static"

const CONTENT_ROOT = webContentRoot()

const TEMPLATES = [
  { title: "AGENTS.md template", path: "templates/AGENTS.md", url: "https://b4.run/AGENTS.md" },
]

async function readContent(relPath: string): Promise<string> {
  return readFile(path.join(CONTENT_ROOT, relPath), "utf8")
}

function docHrefToContentPath(href: string): string {
  const slug = href.replace(/^\/docs\/?/, "")
  return slug === "recipes" ? "docs/recipes/index.mdx" : `docs/${slug}.mdx`
}

// Heading outline: `# B4.run: Full Reference` > `## <part>` > `### <page>`.
// Each page drops its own `# Title` (the `###` heading replaces it) and its
// remaining headings move down two levels, so page `##` sections become `####`.
async function buildLlmsFull(): Promise<string> {
  const sections: string[] = [
    "# B4.run: Full Reference",
    "",
    "Generated reference for coding agents. This file is the concatenation of every B4.run documentation page, task-specific prompt, and agent config template served by b4.run, converted to plain Markdown.",
    "",
    "For the compact summary: https://b4.run/llms.txt",
    "For source: https://github.com/cacheplane/b4run",
    "",
    "## Brand Assets",
    "",
    "Official B4.run logos, icons, favicons, and social assets:",
    "- Asset manifest: https://b4.run/brand/assets.json",
    "- Full brand kit ZIP: https://b4.run/brand/b4-run-brand-assets.zip",
    "",
    "---",
    "",
    "## Documentation",
    "",
  ]

  for (const page of ALL_DOCS_PAGES) {
    const source = await readContent(docHrefToContentPath(page.href))
    sections.push(llmsDocSection(page, source), "", "---", "")
  }

  sections.push("## Task-Specific Prompts", "")
  for (const entry of PROMPTS) {
    sections.push(
      `### ${entry.title}`,
      "",
      `Source: https://b4.run/prompts/${entry.slug}`,
      "",
      mdxToMarkdown(entry.body, { headingOffset: 3 }),
      "",
      "---",
      "",
    )
  }

  sections.push("## Agent Config Templates", "")
  for (const { title, path: p, url } of TEMPLATES) {
    sections.push(
      `### ${title}`,
      "",
      `Source: ${url}`,
      "",
      fencedVerbatim(await readContent(p), "markdown"),
      "",
      "---",
      "",
    )
  }

  sections.push(
    "## Historical Blog Archive",
    "",
    "The posts below are historical, non-normative snapshots. Current contracts are the Documentation, Task-Specific Prompts, and Agent Config Templates above.",
    "",
  )
  for (const post of getAllPosts()) {
    const raw = readFileSync(join(CONTENT_ROOT, "blog", post.sourceFile), "utf8")
    sections.push(
      `### ${post.title}`,
      "",
      `Source: https://b4.run/blog/${post.slug}`,
      `Published: ${post.date}`,
      "",
      `> ${post.description}`,
      "",
      mdxToMarkdown(raw, { dropTitle: true, headingOffset: 2 }),
      "",
      "---",
      "",
    )
  }

  return `${sections.join("\n").trimEnd()}\n`
}

export async function GET() {
  const body = await buildLlmsFull()
  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
