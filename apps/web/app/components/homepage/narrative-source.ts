import "server-only"
import { highlightCode } from "./highlight"
import data from "./narrative-source.json"
import type { DisplayCode } from "./types"

export const narrativeSource = data
export type NarrativeKey = keyof typeof data.snippets

export async function prepareNarrative(): Promise<Record<NarrativeKey, DisplayCode>> {
  const entries = await Promise.all(
    (Object.keys(data.snippets) as NarrativeKey[]).map(async (key) => {
      const snippet = data.snippets[key]
      const source = data.sources[snippet.source as keyof typeof data.sources]
      const raw = source.text
        .split("\n")
        .slice(snippet.start - 1, snippet.end)
        .join("\n")
      const excerpt = raw !== source.text
      const code = await highlightCode(
        raw,
        key === "plan" ? "markdown" : key === "checks" ? "json" : "typescript",
        `${source.path}${excerpt ? " · excerpt" : ""}`,
        `https://github.com/cacheplane/b4run/blob/${data.sourceCommit}/examples/code-fixer/server/${source.path}#L${snippet.start}-L${snippet.end}`,
        snippet.start,
      )
      return [
        key,
        { ...code, wrap: true, ...(key === "agent" ? { fold: { start: 8, end: 21 } } : {}) },
      ] as const
    }),
  )
  return Object.fromEntries(entries) as Record<NarrativeKey, DisplayCode>
}
