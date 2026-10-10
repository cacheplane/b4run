/** The workspace folders the agent searches: FEMA guidance excerpts and the sample plans. */
export const SOURCE_DIRS = ["fema", "plans"] as const

export interface Section {
  readonly heading: string
  readonly text: string
}

export interface SourceDoc {
  readonly path: string
  readonly title: string
  readonly sections: readonly Section[]
}

/** A document's `# title` and its `## ` sections, in order. */
export function parseDoc(path: string, markdown: string): SourceDoc {
  const title = /^# (.+)$/mu.exec(markdown)?.[1]?.trim() ?? path
  const sections: Section[] = []
  for (const part of markdown.split(/^## /mu).slice(1)) {
    const [heading = "", ...body] = part.split("\n")
    sections.push({ heading: heading.trim(), text: body.join(" ").replace(/\s+/gu, " ").trim() })
  }
  return { path, title, sections }
}

/** The anchor a heading gets on the Workbench's source page: "5. Communications" → "5-communications". */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
}

/** Where a citation chip opens: the Workbench's page for the document, at the section. */
export function sourceHref(path: string, heading: string): string {
  return `/sources/${path}#${slug(heading)}`
}

/** A chip's label: the document and the section, e.g. "Sample Lakeview County EOP · 5. Communications". */
export function sourceTitle(doc: Pick<SourceDoc, "title">, heading: string): string {
  return `${doc.title} · ${heading}`
}

export function assertSourcePath(path: string): void {
  const dir = SOURCE_DIRS.find((root) => path.startsWith(`${root}/`))
  if (dir === undefined || path.includes("..") || !path.endsWith(".md")) {
    throw new Error(`Expected a .md path under ${SOURCE_DIRS.join("/ or ")}/, got "${path}"`)
  }
}
