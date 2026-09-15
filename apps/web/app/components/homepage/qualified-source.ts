import "server-only"
import data from "./qualified-source.json"

export const qualifiedSource = data
export type QualifiedCapabilityKey = keyof typeof data.snippets
export type QualifiedSourceKey = keyof typeof data.sources

export function qualifiedExcerpt(key: QualifiedCapabilityKey): string {
  const snippet = data.snippets[key]
  return data.sources[snippet.source as QualifiedSourceKey].text
    .split("\n")
    .slice(snippet.start - 1, snippet.end)
    .join("\n")
}

export function qualifiedSourceUrl(key: QualifiedCapabilityKey): string {
  const snippet = data.snippets[key]
  const source = data.sources[snippet.source as QualifiedSourceKey]
  return `https://github.com/cacheplane/b4run/blob/${data.sourceCommit}/examples/code-fixer/server/${source.path}#L${snippet.start}-L${snippet.end}`
}
