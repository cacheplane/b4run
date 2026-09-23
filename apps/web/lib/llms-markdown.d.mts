export interface MdxToMarkdownOptions {
  /** Levels to move every heading down (capped at H6). */
  readonly headingOffset?: number
  /** Remove the document's leading `# H1`; the caller supplies the heading. */
  readonly dropTitle?: boolean
}

export function mdxToMarkdown(source: string, options?: MdxToMarkdownOptions): string

export function siteUrl(href: string): string

export function llmsDocSection(
  page: { readonly label: string; readonly href: string },
  source: string,
): string

export function fencedVerbatim(source: string, language?: string): string
