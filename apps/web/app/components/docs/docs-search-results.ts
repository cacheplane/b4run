import type { DocsSearchEntry, DocsSearchHeading } from "./search-index"

export interface DocsSearchResult {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly heading?: DocsSearchHeading
  /** First paragraph of the page intro (page rows) or the heading's section. */
  readonly text?: string
  readonly terms?: readonly string[]
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
  readonly aliasSurfaces?: Readonly<Record<string, string>>
  readonly key: string
}

/** Why a result matched, when the title alone does not say. */
export type DocsSearchMatch =
  | { readonly kind: "alias"; readonly alias: string; readonly surface?: string }
  | { readonly kind: "code"; readonly term: string }
  | {
      readonly kind: "text"
      readonly before: string
      readonly match: string
      readonly after: string
    }

export interface DocsSearchHit extends DocsSearchResult {
  readonly match?: DocsSearchMatch
}

export function flattenDocsSearchIndex(
  index: readonly DocsSearchEntry[],
): readonly DocsSearchResult[] {
  const results: DocsSearchResult[] = []
  for (const entry of index) {
    const bodies = new Map((entry.sections ?? []).map((section) => [section.anchor, section]))
    const intro = bodies.get(null)
    results.push({
      href: entry.href,
      title: entry.title,
      section: entry.section,
      ...(intro?.text ? { text: intro.text } : {}),
      ...(intro?.terms.length ? { terms: intro.terms } : {}),
      aliases: entry.aliases,
      canonicalAliases: entry.canonicalAliases,
      ...(entry.aliasSurfaces ? { aliasSurfaces: entry.aliasSurfaces } : {}),
      key: entry.href,
    })
    for (const heading of entry.headings) {
      if (heading.level === 1) continue
      const body = bodies.get(heading.anchor)
      results.push({
        href: `${entry.href}#${heading.anchor}`,
        title: entry.title,
        section: entry.section,
        heading,
        ...(body?.text ? { text: body.text } : {}),
        ...(body?.terms.length ? { terms: body.terms } : {}),
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
// the query; an exact page title beats everything. Body text ranks below
// every title and heading match: it finds pages the titles miss without
// reordering the pages the titles already find.
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
// A code identifier is typed deliberately, so an exact one is worth more than
// a word in prose.
const TERM_SCORES: Record<MatchKind, number> = {
  exact: 110,
  prefix: 45,
  word: 0,
  contains: 30,
}
const BODY_WORD_SCORE = 60
const BODY_CONTAINS_SCORE = 40
const BODY_ALL_WORDS_SCORE = 35

function scoreWith(table: Record<MatchKind, number>, query: string, target: string): number {
  const kind = matchKind(query, target)
  return kind ? table[kind] : 0
}

function bestOf(
  table: Record<MatchKind, number>,
  query: string,
  values: readonly string[],
): { readonly score: number; readonly value?: string } {
  let best: { score: number; value?: string } = { score: 0 }
  for (const value of values) {
    const score = scoreWith(table, query, value)
    if (score > best.score) best = { score, value }
  }
  return best
}

const WORD_START = /[\s([{"'/.,:;-]/

/** Index of `needle` in `haystack` (both lower-cased), preferring a word start. */
function findWord(haystack: string, needle: string): { index: number; word: boolean } {
  let index = haystack.indexOf(needle)
  const first = index
  while (index !== -1) {
    if (index === 0 || WORD_START.test(haystack[index - 1] ?? "")) return { index, word: true }
    index = haystack.indexOf(needle, index + 1)
  }
  return { index: first, word: false }
}

const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 100

function snippet(text: string, index: number, length: number): DocsSearchMatch {
  let start = Math.max(0, index - SNIPPET_BEFORE)
  if (start > 0) {
    const space = text.indexOf(" ", start)
    start = space !== -1 && space < index ? space + 1 : start
  }
  let end = Math.min(text.length, index + length + SNIPPET_AFTER)
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end)
    end = space > index + length ? space : end
  }
  return {
    kind: "text",
    before: `${start > 0 ? "…" : ""}${text.slice(start, index)}`,
    match: text.slice(index, index + length),
    after: `${text.slice(index + length, end)}${end < text.length ? "…" : ""}`,
  }
}

function bodyMatch(
  query: string,
  result: DocsSearchResult,
): { readonly score: number; readonly match?: DocsSearchMatch } {
  const text = result.text
  if (!text) return { score: 0 }
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const phrase = findWord(lower, q)
  if (phrase.index !== -1) {
    return {
      score: phrase.word ? BODY_WORD_SCORE : BODY_CONTAINS_SCORE,
      match: snippet(text, phrase.index, q.length),
    }
  }
  // Several words that all appear somewhere in the section, in any order.
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length < 2) return { score: 0 }
  const haystack = `${result.title} ${result.heading?.text ?? ""} ${text}`.toLowerCase()
  if (!words.every((word) => haystack.includes(word))) return { score: 0 }
  const firstInBody = words
    .map((word) => ({ word, index: lower.indexOf(word) }))
    .filter(({ index }) => index !== -1)
    .sort((left, right) => left.index - right.index)[0]
  return {
    score: BODY_ALL_WORDS_SCORE,
    ...(firstInBody ? { match: snippet(text, firstInBody.index, firstInBody.word.length) } : {}),
  }
}

/**
 * Light English stemming for single-word queries, so "retries" also finds
 * "retry" and "streaming" finds "stream". Variants score slightly below the
 * word as typed.
 */
export function queryVariants(query: string): readonly string[] {
  const q = query.toLowerCase()
  if (q.includes(" ") || q.length < 5) return []
  const variants = new Set<string>()
  if (q.endsWith("ies")) variants.add(`${q.slice(0, -3)}y`)
  else if (/(?:ches|shes|sses|xes)$/.test(q)) variants.add(q.slice(0, -2))
  else if (q.endsWith("s") && !q.endsWith("ss")) variants.add(q.slice(0, -1))
  if (q.endsWith("ing")) variants.add(q.slice(0, -3))
  if (q.endsWith("ed")) variants.add(q.slice(0, -2))
  return [...variants].filter((variant) => variant.length >= 3 && variant !== q)
}

const VARIANT_FACTOR = 0.9

interface Scored {
  readonly score: number
  readonly textScore: number
  readonly match?: DocsSearchMatch
}

function scoreResult(query: string, result: DocsSearchResult): Scored {
  // A page row is scored on its title. A heading row is scored on its
  // heading text, and only weakly on its page's title, so the page itself
  // (and headings that really match) stay above its unrelated sections.
  const titleScore = scoreWith(TITLE_SCORES, query, result.title)
  const textScore = result.heading
    ? Math.max(scoreWith(HEADING_SCORES, query, result.heading.text), titleScore * 0.25)
    : titleScore
  const alias = bestOf(ALIAS_SCORES, query, result.aliases)
  const canonicalAlias = bestOf(CANONICAL_ALIAS_SCORES, query, result.canonicalAliases)
  const term = bestOf(TERM_SCORES, query, result.terms ?? [])
  const body = bodyMatch(query, result)
  const sectionScore = scoreWith(TITLE_SCORES, query, result.section) * 0.05
  const best = Math.max(textScore, alias.score, canonicalAlias.score, term.score, body.score)

  let match: DocsSearchMatch | undefined
  const aliasWin = canonicalAlias.score >= alias.score ? canonicalAlias : alias
  if (aliasWin.value && aliasWin.score === best && aliasWin.score > textScore) {
    const surface = result.aliasSurfaces?.[aliasWin.value]
    match = { kind: "alias", alias: aliasWin.value, ...(surface ? { surface } : {}) }
  } else if (body.match && body.score === best && best > textScore) {
    match = body.match
  } else if (term.value && term.score === best && best > textScore) {
    match = { kind: "code", term: term.value }
  }
  return { score: best + sectionScore, textScore, ...(match ? { match } : {}) }
}

export function filterDocsSearchResults(
  query: string,
  all: readonly DocsSearchResult[],
): readonly DocsSearchHit[] {
  const normalizedQuery = query.trim().replace(/\s+/g, " ")
  if (!normalizedQuery) return all.slice(0, 20)
  const variants = queryVariants(normalizedQuery)
  return all
    .map((result, index) => {
      let scored = scoreResult(normalizedQuery, result)
      for (const variant of variants) {
        const candidate = scoreResult(variant, result)
        if (candidate.score * VARIANT_FACTOR > scored.score) {
          scored = { ...candidate, score: candidate.score * VARIANT_FACTOR }
        }
      }
      return { result, index, ...scored }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 20)
    .map(({ result, match }) => (match ? { ...result, match } : result))
}
