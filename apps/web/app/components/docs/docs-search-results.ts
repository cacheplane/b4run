import type { DocsSearchEntry, DocsSearchHeading } from "./search-index"

export interface DocsSearchResult {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly heading?: DocsSearchHeading
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
  readonly key: string
}

export function flattenDocsSearchIndex(
  index: readonly DocsSearchEntry[],
): readonly DocsSearchResult[] {
  const results: DocsSearchResult[] = []
  for (const entry of index) {
    results.push({
      href: entry.href,
      title: entry.title,
      section: entry.section,
      aliases: entry.aliases,
      canonicalAliases: entry.canonicalAliases,
      key: entry.href,
    })
    for (const heading of entry.headings) {
      if (heading.level === 1) continue
      results.push({
        href: `${entry.href}#${heading.anchor}`,
        title: entry.title,
        section: entry.section,
        heading,
        aliases: [],
        canonicalAliases: [],
        key: `${entry.href}#${heading.anchor}`,
      })
    }
  }
  return results
}

type MatchKind = "exact" | "prefix" | "word" | "contains"

function matchKind(query: string, target: string): MatchKind | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t === q) return "exact"
  if (t.startsWith(q)) return "prefix"
  if (t.includes(` ${q}`)) return "word"
  if (t.includes(q)) return "contains"
  return null
}

// Tiered scores: what a reader types is usually a concept, so guide titles
// and headings outrank partial API export names. Only an exact export name
// (or package name) can beat a page title that merely starts with or contains
// the query; an exact page title beats everything.
const TITLE_SCORES: Record<MatchKind, number> = {
  exact: 400,
  prefix: 300,
  word: 200,
  contains: 120,
}
const CANONICAL_ALIAS_SCORES: Record<MatchKind, number> = {
  exact: 380,
  prefix: 110,
  word: 90,
  contains: 60,
}
const ALIAS_SCORES: Record<MatchKind, number> = {
  exact: 360,
  prefix: 100,
  word: 80,
  contains: 50,
}
const HEADING_SCORES: Record<MatchKind, number> = {
  exact: 180,
  prefix: 160,
  word: 130,
  contains: 70,
}

function scoreWith(table: Record<MatchKind, number>, query: string, target: string): number {
  const kind = matchKind(query, target)
  return kind ? table[kind] : 0
}

function bestAliasScore(
  table: Record<MatchKind, number>,
  query: string,
  aliases: readonly string[],
): number {
  return aliases.reduce((best, alias) => Math.max(best, scoreWith(table, query, alias)), 0)
}

export function filterDocsSearchResults(
  query: string,
  all: readonly DocsSearchResult[],
): readonly DocsSearchResult[] {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return all.slice(0, 20)
  return all
    .map((result, index) => {
      // A page row is scored on its title. A heading row is scored on its
      // heading text, and only weakly on its page's title, so the page itself
      // (and headings that really match) stay above its unrelated sections.
      const titleScore = scoreWith(TITLE_SCORES, normalizedQuery, result.title)
      const textScore = result.heading
        ? Math.max(
            scoreWith(HEADING_SCORES, normalizedQuery, result.heading.text),
            titleScore * 0.25,
          )
        : titleScore
      const aliasScore = bestAliasScore(ALIAS_SCORES, normalizedQuery, result.aliases)
      const canonicalAliasScore = bestAliasScore(
        CANONICAL_ALIAS_SCORES,
        normalizedQuery,
        result.canonicalAliases,
      )
      const sectionScore = scoreWith(TITLE_SCORES, normalizedQuery, result.section) * 0.05
      const best = Math.max(textScore, aliasScore, canonicalAliasScore)
      return { result, index, score: best + sectionScore }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 20)
    .map(({ result }) => result)
}
