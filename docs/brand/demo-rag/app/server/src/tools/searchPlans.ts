import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { parseDoc, SOURCE_DIRS, sourceHref, sourceTitle } from "../lib/sources.js"

export interface PlanHit {
  readonly path: string
  readonly title: string
  readonly heading: string
  readonly snippet: string
  readonly score: number
}

/**
 * Keyword search over the FEMA guidance excerpts and the county plans. Each
 * `##` section is scored by how many query terms it contains; returns up to
 * five sections, best first, with a short snippet around the first match.
 */
export default async (
  input: { readonly query: string },
  ctx: B4ToolContext,
): Promise<readonly PlanHit[]> => {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 2)
  const hits: PlanHit[] = []
  for (const dir of SOURCE_DIRS) {
    for (const file of (await ctx.fs.listDir(dir)).filter((name) => name.endsWith(".md"))) {
      const doc = parseDoc(`${dir}/${file}`, await ctx.fs.readFile(`${dir}/${file}`))
      for (const section of doc.sections) {
        const haystack = `${section.heading} ${section.text}`.toLowerCase()
        const score = terms.filter((term) => haystack.includes(term)).length
        if (score === 0) continue
        const first = terms.find((term) => section.text.toLowerCase().includes(term))
        const at = first === undefined ? 0 : section.text.toLowerCase().indexOf(first)
        const snippet = section.text.slice(Math.max(0, at - 40), at + 120).trim()
        hits.push({ path: doc.path, title: doc.title, heading: section.heading, snippet, score })
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 5)
}

/** A citation chip: the section's title, linked to it on the Workbench's source page. */
const citation = (hit: PlanHit) => ({
  title: sourceTitle(hit, hit.heading),
  href: sourceHref(hit.path, hit.heading),
})

export const display = {
  icon: "search",
  running: ({ query }) => `Searching the plans for “${query}”`,
  done: ({ query }, hits) => `Found ${hits.length} sections for “${query}”`,
  sources: (hits) => hits.map(citation),
} satisfies ToolDisplay<{ readonly query: string }, readonly PlanHit[]>
