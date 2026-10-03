// Server-side index builder. Reads every MDX doc page at module init, extracts
// H1/H2/H3 headings and each section's prose, and exports a flat searchable
// index.
//
// This module is intentionally server-only (uses node:fs). The resulting
// `DOCS_INDEX` is served as the static `/search-index.json` route and fetched
// by the search dialog the first time it opens, so no page carries it inline.

import { readFileSync } from "node:fs"
import path from "node:path"
import { createProcessor } from "@mdx-js/mdx"
import GithubSlugger from "github-slugger"
import remarkGfm from "remark-gfm"
import { webContentRoot } from "../../../lib/content-root"
import { ARTIFACT_REGISTRY, PACKAGE_CATALOG } from "./api-reference"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { ALL_DOCS_PAGES, DOCS_NAV, type DocsNavItem } from "./nav"

export interface DocsSearchHeading {
  readonly text: string
  readonly level: 1 | 2 | 3
  readonly anchor: string
}

/**
 * The prose of one section: the page intro (`anchor: null`) or everything under
 * an H2/H3 up to the next H2/H3. Deeper headings fold into their parent.
 */
export interface DocsSearchSection {
  readonly anchor: string | null
  /** Plain text with Markdown, JSX, and code fences removed. */
  readonly text: string
  /** Identifiers that appear only in the section's code blocks. */
  readonly terms: readonly string[]
}

export interface DocsSearchEntry {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly headings: readonly DocsSearchHeading[]
  readonly sections: readonly DocsSearchSection[]
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
  /** Export alias → the package surface whose table lists it (API pages). */
  readonly aliasSurfaces: Readonly<Record<string, string>>
}

function packageSurface(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`
}

interface PublicExportAliases {
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
  readonly aliasSurfaces: Readonly<Record<string, string>>
}

function maskSearchMdx(source: string): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ")
  const lines = source.split(/(?<=\n)/)
  let fence: { readonly character: string; readonly length: number } | null = null
  const fencesMasked = lines
    .map((line) => {
      const content = line.replace(/\r?\n$/, "")
      if (fence) {
        const close = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(content)?.[1]
        if (close?.[0] === fence.character && close.length >= fence.length) fence = null
        return mask(line)
      }
      const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      if (!opening || (opening[1]?.[0] === "`" && opening[2]?.includes("`"))) return line
      fence = { character: opening[1]?.[0] ?? "", length: opening[1]?.length ?? 0 }
      return mask(line)
    })
    .join("")
  const maskedLines = fencesMasked.split(/(?<=\n)/)
  let inHtmlComment = false
  return maskedLines
    .map((line) => {
      if (inHtmlComment) {
        if (line.includes("-->")) inHtmlComment = false
        return mask(line)
      }
      if (/^[ \t]*<!--/.test(line)) {
        if (!line.includes("-->")) inHtmlComment = true
        return mask(line)
      }
      return line.replace(/<!--[\s\S]*?-->/g, mask)
    })
    .join("")
}

interface SearchMdxNode {
  readonly type: string
  readonly depth?: number
  readonly value?: string
  readonly url?: string
  readonly children?: readonly SearchMdxNode[]
  readonly position?: {
    readonly start: { readonly line: number }
    readonly end: { readonly line: number }
  }
}

interface OwnershipTableSpec {
  readonly heading: string
  readonly firstHeader: "Export" | "Generated export"
}

const searchMdxProcessor = createProcessor({ remarkPlugins: [remarkGfm] })

function exactTextHeading(node: SearchMdxNode, depth: number, text: string): boolean {
  return (
    node.type === "heading" &&
    node.depth === depth &&
    node.children?.length === 1 &&
    node.children[0]?.type === "text" &&
    node.children[0]?.value === text
  )
}

function exactCodeHeading(node: SearchMdxNode): string | undefined {
  if (
    node.type !== "heading" ||
    node.depth !== 3 ||
    node.children?.length !== 1 ||
    node.children[0]?.type !== "inlineCode"
  ) {
    return undefined
  }
  return node.children[0].value
}

function tableHeader(node: SearchMdxNode): readonly string[] | undefined {
  if (node.type !== "table") return undefined
  const header = node.children?.[0]
  if (header?.type !== "tableRow") return undefined
  return header.children?.map((cell) => cell.children?.[0]?.value ?? "")
}

function urlsIn(node: SearchMdxNode): readonly string[] {
  return [
    ...(node.type === "link" && node.url ? [node.url] : []),
    ...(node.children?.flatMap(urlsIn) ?? []),
  ]
}

export function parsePublicExportAliases(
  mdx: string,
  href: string,
  expectedTables: readonly OwnershipTableSpec[],
): PublicExportAliases {
  const maskedMdx = maskSearchMdx(mdx)
  const lines = maskedMdx.split(/\r?\n/)
  const root = searchMdxProcessor.parse(maskedMdx) as SearchMdxNode
  const children = root.children ?? []
  const sectionStarts = children.flatMap((node, index) =>
    exactTextHeading(node, 2, "Public exports") ? [index] : [],
  )
  if (sectionStarts.length !== 1) {
    throw new Error(`${href} must contain exactly one visible Public exports section`)
  }
  const start = sectionStarts[0] as number
  const end = children.findIndex(
    (node, index) => index > start && node.type === "heading" && node.depth === 2,
  )
  const sectionEnd = end === -1 ? children.length : end
  const sectionChildren = children.slice(start + 1, sectionEnd)
  const aliases: string[] = []
  const canonicalAliases: string[] = []
  const aliasSurfaces: Record<string, string> = {}
  const surfaceHeadingIndexes = new Map<string, number[]>()
  for (const [index, node] of sectionChildren.entries()) {
    const surface = exactCodeHeading(node)
    if (!surface) continue
    const indexes = surfaceHeadingIndexes.get(surface) ?? []
    indexes.push(index)
    surfaceHeadingIndexes.set(surface, indexes)
  }
  const expectedIndexes = expectedTables.map(({ heading }) => {
    const indexes = surfaceHeadingIndexes.get(heading) ?? []
    if (indexes.length !== 1) {
      throw new Error(`${href} must contain exactly one Public exports heading for ${heading}`)
    }
    return indexes[0] as number
  })
  if (
    expectedIndexes.some((index, position) => {
      const previous = expectedIndexes[position - 1]
      return previous !== undefined && index <= previous
    })
  ) {
    throw new Error(`${href} Public exports headings must follow artifact registry order`)
  }

  const expectedHeadings = new Set(expectedTables.map(({ heading }) => heading))
  for (const [position, headingIndex] of expectedIndexes.entries()) {
    const spec = expectedTables[position] as OwnershipTableSpec
    const nextHeadingOffset = sectionChildren
      .slice(headingIndex + 1)
      .findIndex((node) => node.type === "heading")
    const headingEnd =
      nextHeadingOffset === -1 ? sectionChildren.length : headingIndex + 1 + nextHeadingOffset
    const tables = sectionChildren
      .slice(headingIndex + 1, headingEnd)
      .filter((node) => node.type === "table")
    if (tables.length !== 1) {
      throw new Error(`${href} has a malformed Public exports ownership table`)
    }
    const table = tables[0] as SearchMdxNode
    if (tableHeader(table)?.join("\0") !== `${spec.firstHeader}\0Responsibility`) {
      throw new Error(`${href} has a malformed Public exports ownership table header`)
    }
    const tableStart = table.position?.start.line
    const tableEnd = table.position?.end.line
    if (!tableStart || !tableEnd) throw new Error(`${href} ownership table lacks source positions`)
    const tableLines = lines.slice(tableStart - 1, tableEnd)
    if (
      tableLines[0] !== `| ${spec.firstHeader} | Responsibility |` ||
      tableLines[1] !== "|---|---|"
    ) {
      throw new Error(`${href} has a malformed Public exports ownership table grammar`)
    }
    const rows = table.children?.slice(1) ?? []
    if (rows.length === 0) throw new Error(`${href} Public exports ownership table is empty`)
    for (const [rowIndex, rowNode] of rows.entries()) {
      const row = /^\| `([^`]+)` \| (.+) \|$/.exec(tableLines[rowIndex + 2] ?? "")
      if (!row?.[1] || !row[2]) {
        throw new Error(`${href} Public exports rows require an exact code-formatted Export cell`)
      }
      if (!aliases.includes(row[1])) {
        aliases.push(row[1])
        aliasSurfaces[row[1]] = spec.heading
      }
      const linkedOwners = urlsIn(rowNode).flatMap((url) => {
        const owner = /^(\/docs\/api\/[^#?]+)(?:[#?].*)?$/.exec(url)?.[1]
        return owner ? [owner] : []
      })
      if (linkedOwners.every((owner) => owner === href) && !canonicalAliases.includes(row[1])) {
        canonicalAliases.push(row[1])
      }
    }
  }
  for (const [index, node] of sectionChildren.entries()) {
    const heading = exactCodeHeading(node)
    if (!heading || expectedHeadings.has(heading)) continue
    const nextHeadingOffset = sectionChildren
      .slice(index + 1)
      .findIndex((candidate) => candidate.type === "heading")
    const headingEnd =
      nextHeadingOffset === -1 ? sectionChildren.length : index + 1 + nextHeadingOffset
    const hasUnexpectedOwnershipTable = sectionChildren
      .slice(index + 1, headingEnd)
      .some((candidate) => {
        const header = tableHeader(candidate)
        return (
          header?.[1] === "Responsibility" &&
          (header[0] === "Export" || header[0] === "Generated export")
        )
      })
    if (hasUnexpectedOwnershipTable) {
      throw new Error(`${href} has an ownership table for unregistered surface ${heading}`)
    }
  }
  return { aliases, canonicalAliases, aliasSurfaces }
}

function ownershipTablesByHref(): ReadonlyMap<string, readonly OwnershipTableSpec[]> {
  const tables = new Map<string, OwnershipTableSpec[]>()
  const destinationByPackage = new Map(
    PACKAGE_CATALOG.map(({ packageName, canonicalReferenceDestination }) => [
      packageName,
      canonicalReferenceDestination.split("#", 1)[0] ?? canonicalReferenceDestination,
    ]),
  )
  const add = (href: string, spec: OwnershipTableSpec) => {
    const values = tables.get(href) ?? []
    values.push(spec)
    tables.set(href, values)
  }
  for (const artifact of ARTIFACT_REGISTRY) {
    if (artifact.kind === "generated") {
      add(artifact.ownerHref, { heading: artifact.moduleName, firstHeader: "Generated export" })
      continue
    }
    if (
      artifact.kind !== "import" ||
      artifact.coverage !== "detailed" ||
      artifact.surfaceKind !== "typescript-runtime"
    ) {
      continue
    }
    const destination = destinationByPackage.get(artifact.packageName)
    if (destination) {
      add(destination, {
        heading: packageSurface(artifact.packageName, artifact.subpath),
        firstHeader: "Export",
      })
    }
  }
  return tables
}

function registryAliasesByHref(): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, Set<string>>()
  const add = (href: string, alias: string) => {
    const canonicalHref = href.split("#", 1)[0] ?? href
    const values = aliases.get(canonicalHref) ?? new Set<string>()
    values.add(alias)
    aliases.set(canonicalHref, values)
  }
  const destinationByPackage = new Map(
    PACKAGE_CATALOG.map(({ packageName, canonicalReferenceDestination }) => [
      packageName,
      canonicalReferenceDestination,
    ]),
  )
  for (const entry of PACKAGE_CATALOG) add(entry.canonicalReferenceDestination, entry.packageName)
  for (const artifact of ARTIFACT_REGISTRY) {
    if (artifact.kind === "generated") {
      add(artifact.ownerHref, artifact.moduleName)
      continue
    }
    const destination = destinationByPackage.get(artifact.packageName)
    if (!destination) continue
    if (artifact.kind === "import") {
      add(destination, packageSurface(artifact.packageName, artifact.subpath))
    } else {
      add(destination, artifact.selector)
      if (artifact.selector.startsWith("bin.")) add(destination, artifact.selector.slice(4))
    }
  }
  return new Map([...aliases].map(([href, values]) => [href, [...values]]))
}

// Each section contributes its leading prose (its first paragraph, and what
// follows it up to the cap), so the lazily fetched index stays small — the
// whole docs set is ~0.8 MB of MDX.
const SECTION_TEXT_LIMIT = 320
const SECTION_TERMS_LIMIT = 40

/** Markdown/MDX prose line → plain text; returns "" for non-prose lines. */
function proseText(line: string): string {
  const trimmed = line.trim()
  if (/^(import|export)\s/.test(trimmed)) return ""
  if (/^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.includes("-")) return ""
  return trimmed
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/^(?:[-*+]|\d+\.|>)\s+/, "")
    .replace(/\|/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Code-only identifiers worth finding: camelCase, PascalCase, dotted, or
// hyphenated names — not ordinary words, which the prose already carries.
const CODE_TERM = /[A-Za-z_$][\w$]*(?:[.-][A-Za-z_$][\w$]*)*/g
function codeTerms(line: string): string[] {
  return (line.match(CODE_TERM) ?? []).filter(
    (term) => term.length >= 4 && /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|[.-]/.test(term),
  )
}

interface ExtractedDocument {
  readonly headings: readonly DocsSearchHeading[]
  readonly sections: readonly DocsSearchSection[]
}

export function extractSearchDocument(mdx: string): ExtractedDocument {
  const headings: DocsSearchHeading[] = []
  const sections: { anchor: string | null; text: string[]; length: number; terms: Set<string> }[] =
    [{ anchor: null, text: [], length: 0, terms: new Set() }]
  // The same slugger `rehype-slug` runs, one instance per document, fed every
  // heading level in document order — that shared state (its duplicate-suffix
  // counter) is what keeps these anchors identical to the ids in the built page.
  const slugger = new GithubSlugger()
  let inFence = false
  // A JSX element whose opening tag spans lines (e.g. a prop holding a long
  // template string) is not prose; skip until its tag closes.
  let inJsxTag = false
  for (const line of mdx.split("\n")) {
    const trimmed = line.trim()
    const current = sections[sections.length - 1] as (typeof sections)[number]
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      for (const term of codeTerms(line)) current.terms.add(term)
      continue
    }
    if (inJsxTag) {
      if (/\/?>\s*$/.test(trimmed)) inJsxTag = false
      continue
    }
    if (/^<[A-Za-z]/.test(trimmed) && !/>/.test(trimmed)) {
      inJsxTag = true
      continue
    }
    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (match?.[1] && match[2]) {
      const level = match[1].length
      const text = match[2].trim().replace(/`([^`]+)`/g, "$1")
      const anchor = slugger.slug(text)
      // The anchor is slugged from the same text rehype-slug sees; only the
      // displayed text drops remaining Markdown (links, emphasis).
      if (level <= 3) headings.push({ text: proseText(text), level: level as 1 | 2 | 3, anchor })
      if (level === 2 || level === 3) {
        sections.push({ anchor, text: [], length: 0, terms: new Set() })
      } else if (level > 3 && current.length <= SECTION_TEXT_LIMIT) {
        current.text.push(text)
        current.length += text.length + 1
      }
      continue
    }
    if (current.length > SECTION_TEXT_LIMIT) continue
    const prose = proseText(line)
    if (prose) {
      current.text.push(prose)
      current.length += prose.length + 1
    }
  }
  return {
    headings,
    sections: sections.flatMap(({ anchor, text, terms }) => {
      const joined = text.join(" ")
      const body =
        joined.length > SECTION_TEXT_LIMIT
          ? `${joined.slice(0, SECTION_TEXT_LIMIT).replace(/\s+\S*$/, "")}…`
          : joined
      const prose = body.toLowerCase()
      const codeOnly = [...terms]
        .filter((term) => !prose.includes(term.toLowerCase()))
        .slice(0, SECTION_TERMS_LIMIT)
      if (!body && codeOnly.length === 0) return []
      return [{ anchor, text: body, terms: codeOnly }]
    }),
  }
}

function slugFromHref(href: string): string {
  return href.replace(/^\/docs\//, "")
}

function readMdx(slug: string): string {
  const base = path.join(webContentRoot(), "docs")
  // Try `<slug>.mdx` first; fall back to `<slug>/index.mdx` for nested
  // section landing pages (e.g. `/docs/recipes` → `recipes/index.mdx`).
  try {
    return readFileSync(path.join(base, `${slug}.mdx`), "utf8")
  } catch {
    return readFileSync(path.join(base, slug, "index.mdx"), "utf8")
  }
}

function buildEntry(
  item: DocsNavItem,
  section: string,
  registryAliases: readonly string[],
  expectedOwnershipTables: readonly OwnershipTableSpec[],
): DocsSearchEntry {
  const slug = slugFromHref(item.href)
  const mdx = readMdx(slug)
  const { headings, sections } = extractSearchDocument(mdx)
  const h1 = headings.find((h) => h.level === 1)
  const exportAliases = item.href.startsWith("/docs/api/")
    ? parsePublicExportAliases(mdx, item.href, expectedOwnershipTables)
    : { aliases: [], canonicalAliases: [], aliasSurfaces: {} }
  return {
    href: item.href,
    title: h1?.text ?? item.label,
    section,
    headings,
    sections,
    aliases: [...new Set([...registryAliases, ...exportAliases.aliases])],
    canonicalAliases: exportAliases.canonicalAliases,
    aliasSurfaces: exportAliases.aliasSurfaces,
  }
}

function buildIndex(): readonly DocsSearchEntry[] {
  const aliasesByHref = registryAliasesByHref()
  const ownershipTables = ownershipTablesByHref()
  const sectionByHref = new Map<string, string>(
    DOCS_NAV.flatMap((section) => section.items.map((item) => [item.href, section.label])),
  )
  const apiReferenceSectionByHref = new Map<string, string>(
    API_REFERENCE_PAGES.map(({ href, parent }) => [href, parent.label]),
  )
  return ALL_DOCS_PAGES.map((item) => {
    const section = apiReferenceSectionByHref.get(item.href) ?? sectionByHref.get(item.href)
    if (!section) throw new Error(`Documentation page ${item.href} has no search section`)
    return buildEntry(
      item,
      section,
      aliasesByHref.get(item.href) ?? [],
      ownershipTables.get(item.href) ?? [],
    )
  })
}

export const DOCS_INDEX: readonly DocsSearchEntry[] = buildIndex()
