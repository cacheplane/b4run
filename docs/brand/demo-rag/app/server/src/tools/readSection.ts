import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { assertSourcePath, parseDoc, slug, sourceHref, sourceTitle } from "../lib/sources.js"

export interface SectionText {
  readonly path: string
  readonly title: string
  readonly heading: string
  readonly text: string
}

/**
 * Read one section of a FEMA excerpt or a county plan, by its path and its
 * heading as searchPlans returned them, e.g. "5. Communications".
 */
export default async (
  input: { readonly path: string; readonly heading: string },
  ctx: B4ToolContext,
): Promise<SectionText> => {
  assertSourcePath(input.path)
  const doc = parseDoc(input.path, await ctx.fs.readFile(input.path))
  const section = doc.sections.find((candidate) => slug(candidate.heading) === slug(input.heading))
  if (section === undefined) {
    const headings = doc.sections.map((candidate) => `"${candidate.heading}"`).join(", ")
    throw new Error(`${input.path} has no section "${input.heading}"; its sections are ${headings}`)
  }
  return { path: doc.path, title: doc.title, heading: section.heading, text: section.text }
}

export const display = {
  icon: "read",
  running: ({ heading }) => `Reading “${heading}”`,
  done: ({ path }, section) => `Read “${section.heading}” in ${path}`,
  sources: (section) => [
    {
      title: sourceTitle(section, section.heading),
      href: sourceHref(section.path, section.heading),
    },
  ],
} satisfies ToolDisplay<{ readonly path: string; readonly heading: string }, SectionText>
