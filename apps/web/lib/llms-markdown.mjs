// Converts authored MDX into plain Markdown for /llms-full.txt.
//
// Plain JavaScript (typed by llms-markdown.d.mts) so the route handler and the
// post-build audit (scripts/audit-built-seo.mjs, run by bare node) share one
// implementation: the audit checks that every docs page appears exactly once in
// the served file, and it can only do that by rendering the same section.

const SITE_ORIGIN = "https://b4.run"
const MAX_HEADING_LEVEL = 6
const CALLOUT_LABELS = { info: "Info", tip: "Tip", warn: "Warning", danger: "Danger" }

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*"([^"]*)"\\s*\\})`),
  )
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3])
}

function absoluteUrl(href) {
  return href.startsWith("/") && !href.startsWith("//") ? `${SITE_ORIGIN}${href}` : href
}

/** Rewrites root-relative Markdown link targets (`](/docs/x)`) outside inline code. */
function absolutizeLinks(line) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replaceAll(/\]\((\/(?!\/)[^)\s]*)\)/g, `](${SITE_ORIGIN}$1)`),
    )
    .join("")
}

function stripFrontmatter(source) {
  if (!source.startsWith("---\n")) return source
  const end = source.indexOf("\n---", 4)
  if (end < 0) return source
  const after = source.indexOf("\n", end + 4)
  return after < 0 ? "" : source.slice(after + 1)
}

function relatedCardItems(block) {
  const items = []
  for (const object of block.matchAll(/\{([^{}]*)\}/g)) {
    const fields = {}
    for (const field of (object[1] ?? "").matchAll(/(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      fields[field[1]] = (field[2] ?? "").replaceAll(/\\(.)/g, "$1")
    }
    if (fields.href !== undefined && fields.title !== undefined) items.push(fields)
  }
  return items
}

function fenceOpening(line) {
  const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
  return match === null
    ? undefined
    : { indent: match[1] ?? "", marker: match[2] ?? "```", info: (match[3] ?? "").trim() }
}

function isBlank(line) {
  return line.trim() === "" || line === ">"
}

function collapseBlankLines(lines) {
  const result = []
  for (const line of lines) {
    const previous = result[result.length - 1]
    if (isBlank(line) && (previous === undefined || isBlank(previous))) continue
    result.push(line)
  }
  while (result.length > 0 && isBlank(result[result.length - 1])) result.pop()
  return result
}

/**
 * Converts one authored MDX/Markdown document to plain Markdown.
 *
 * - Frontmatter, single-line MDX comments, and ESM import/export lines outside
 *   code are removed.
 * - `<Callout type title>` becomes a blockquote led by its label and title.
 * - `<RelatedCards items>` becomes a "Related:" list of absolute links.
 * - `<CodeGroup>`/`<Tabs>` wrappers are removed so their code blocks read
 *   sequentially; a fence's `title="..."` becomes a caption line above it.
 * - `<Step title>` becomes a numbered sub-heading; `<Tab label>` a titled one.
 * - `<CopyPromptButton promptSlug>` becomes a link to the copy-ready prompt.
 * - With `dropTitle`, the leading `# H1` is removed (the caller supplies the
 *   section heading); every heading then moves down `headingOffset` levels,
 *   capped at H6.
 * - Root-relative Markdown links become absolute b4.run URLs.
 *
 * Code inside fences is copied verbatim.
 */
export function mdxToMarkdown(source, options = {}) {
  const headingOffset = options.headingOffset ?? 0
  const lines = stripFrontmatter(source.replaceAll("\r\n", "\n")).split("\n")
  const out = []
  let fence
  let calloutDepth = 0
  let titlePending = options.dropTitle ?? false
  let lastHeadingLevel = Math.min(1 + headingOffset, MAX_HEADING_LEVEL)
  const stepCounters = []

  const push = (text) => {
    out.push(calloutDepth > 0 ? (text === "" ? ">" : `> ${text}`) : text)
  }
  const subheading = (title) => {
    push(`${"#".repeat(Math.min(lastHeadingLevel + 1, MAX_HEADING_LEVEL))} ${title}`)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ""
    const line = calloutDepth > 0 ? raw.replace(/^ {2}/, "") : raw

    if (fence !== undefined) {
      push(line)
      const closing = line.trim()
      if (closing.startsWith(fence) && closing.replaceAll(fence[0], "") === "") fence = undefined
      continue
    }

    const trimmed = line.trim()
    const opening = fenceOpening(line)
    if (opening !== undefined) {
      fence = opening.marker
      const title = attribute(opening.info, "title")
      const language = opening.info.split(/\s+/)[0] ?? ""
      if (title !== undefined) {
        push(`${opening.indent}\`${title}\`:`)
        push("")
      }
      push(`${opening.indent}${opening.marker}${language.includes("=") ? "" : language}`)
      continue
    }

    // MDX comments (`{/* ... */}`) are authoring notes, not content.
    if (/^\{\/\*.*\*\/\}$/.test(trimmed)) continue
    if (
      /^(?:import\s.*\sfrom\s+["']|import\s+["']|export\s+(?:const|default|function)\s)/.test(line)
    ) {
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading !== null) {
      const authoredLevel = (heading[1] ?? "#").length
      if (titlePending && authoredLevel === 1) {
        titlePending = false
        continue
      }
      titlePending = false
      const level = Math.min(authoredLevel + headingOffset, MAX_HEADING_LEVEL)
      lastHeadingLevel = level
      push(`${"#".repeat(level)} ${absolutizeLinks(heading[2] ?? "")}`)
      continue
    }
    if (trimmed !== "") titlePending = false

    if (trimmed.startsWith("<Callout")) {
      const type = attribute(trimmed, "type") ?? "info"
      const title = attribute(trimmed, "title")
      const label = CALLOUT_LABELS[type] ?? "Note"
      push("")
      calloutDepth += 1
      push(title === undefined ? `**${label}**` : `**${label}: ${title}**`)
      push("")
      continue
    }
    if (trimmed === "</Callout>") {
      while (out.length > 0 && out[out.length - 1] === ">") out.pop()
      calloutDepth = Math.max(0, calloutDepth - 1)
      push("")
      continue
    }

    if (trimmed.startsWith("<RelatedCards")) {
      let block = trimmed
      while (!/\/>\s*$|<\/RelatedCards>\s*$/.test(block) && index + 1 < lines.length) {
        index += 1
        block += `\n${lines[index] ?? ""}`
      }
      const previous = [...out].reverse().find((text) => !isBlank(text))
      if (previous === undefined || !/^#{1,6}\s/.test(previous)) {
        push("Related:")
        push("")
      }
      for (const item of relatedCardItems(block)) {
        const summary = item.subtitle ?? item.description
        push(
          `- [${item.title}](${absoluteUrl(item.href)})${summary === undefined ? "" : `: ${summary}`}`,
        )
      }
      push("")
      continue
    }

    if (/^<\/?(?:CodeGroup|Tabs)>$/.test(trimmed)) continue
    if (trimmed === "<Steps>") {
      stepCounters.push(0)
      continue
    }
    if (trimmed === "</Steps>") {
      stepCounters.pop()
      continue
    }
    if (trimmed === "<Step>" || trimmed.startsWith("<Step ")) {
      const position = stepCounters.length - 1
      const count = (stepCounters[position] ?? 0) + 1
      if (position >= 0) stepCounters[position] = count
      const title = attribute(trimmed, "title")
      subheading(`Step ${count}${title === undefined ? "" : `: ${title}`}`)
      continue
    }
    if (trimmed === "</Step>" || trimmed === "</Tab>") continue
    if (trimmed === "<Tab>" || trimmed.startsWith("<Tab ")) {
      const title = attribute(trimmed, "label") ?? attribute(trimmed, "title")
      if (title !== undefined) subheading(title)
      continue
    }
    if (trimmed.startsWith("<CopyPromptButton")) {
      const slug = attribute(trimmed, "promptSlug")
      if (slug !== undefined) push(`Copy-ready prompt: ${SITE_ORIGIN}/prompts/${slug}`)
      continue
    }

    push(absolutizeLinks(line))
  }

  return collapseBlankLines(out).join("\n")
}

/** Canonical site URL for a root-relative href such as `/docs/tools`. */
export function siteUrl(href) {
  return absoluteUrl(href)
}

/**
 * One documentation page as served in /llms-full.txt: an H3 page heading, the
 * canonical URL, and the page body with its own title removed and its headings
 * moved under the section heading (page H2 becomes H4).
 */
export function llmsDocSection(page, source) {
  return [
    `### ${page.label}`,
    "",
    `Source: ${absoluteUrl(page.href)}`,
    "",
    mdxToMarkdown(source, { dropTitle: true, headingOffset: 2 }),
  ].join("\n")
}

/** Wraps a verbatim file in a backtick fence longer than any run it contains. */
export function fencedVerbatim(source, language = "") {
  const longest = Math.max(2, ...[...source.matchAll(/`{3,}/g)].map((match) => match[0].length))
  const marker = "`".repeat(longest + 1)
  return `${marker}${language}\n${source.replace(/\n+$/, "")}\n${marker}`
}
