"use client"
import { useJsonParser, useUiKit } from "@hashbrownai/react"
import { type ReactNode, useContext, useMemo } from "react"
import {
  BriefMarkdownContext,
  briefComponents,
  CitationsContext,
  type CitationsContextValue,
} from "./components"
import { isStructuredAnswer } from "./parse"
import type { Citation } from "./schema"

export interface BriefRendererProps {
  /** The assistant's answer as it stands: a (possibly partial) JSON answer, or markdown. */
  readonly content: string
  /** Prefixes the citation anchors, so several answers on one page do not collide. */
  readonly idPrefix?: string | undefined
}

/**
 * The citation list of a parsed answer: the `Citations` component's items,
 * once its props are complete (hashbrown's streamed node shape,
 * `{ Citations: { props: { complete, value } } }`).
 */
function citationsOf(value: unknown): readonly Citation[] {
  const ui = (value as { ui?: unknown } | undefined)?.ui
  if (!Array.isArray(ui)) return []
  for (const node of ui) {
    const props = (node as { Citations?: { props?: { value?: { items?: unknown } } } } | null)
      ?.Citations?.props
    const items = props?.value?.items
    if (Array.isArray(items)) return items as Citation[]
  }
  return []
}

/** Whether a complete string parses as JSON at all. */
function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function Markdown({ content }: { readonly content: string }) {
  const Renderer = useContext(BriefMarkdownContext)
  return <Renderer content={content} />
}

function StructuredAnswer({ content, idPrefix }: BriefRendererProps) {
  const uiKit = useUiKit({ components: briefComponents })
  const { value, error } = useJsonParser(content, uiKit.schema)
  const citations = useMemo<CitationsContextValue>(
    () => ({ items: citationsOf(value), idPrefix: idPrefix ?? "" }),
    [value, idPrefix],
  )
  // Not JSON after all, or JSON that is complete but no answer: show the text.
  if (error !== undefined || (value === undefined && parses(content))) {
    return <Markdown content={content} />
  }
  if (value === undefined) return null
  let rendered: ReactNode
  try {
    rendered = uiKit.render(value)
  } catch {
    // hashbrown validates a fully streamed answer; one that fails is shown as text.
    return <Markdown content={content} />
  }
  return <CitationsContext.Provider value={citations}>{rendered}</CitationsContext.Provider>
}

/**
 * One assistant answer, in the chat or the sheet's Brief tab. A structured
 * answer (`{ "ui": [...] }`, the shape `briefJsonSchema` asks for) is parsed
 * as it streams and rendered with the brief kit, each component appearing once
 * its props are complete. Anything else (a thread from before the kit, an
 * answer without the schema) renders as markdown through
 * `BriefMarkdownContext`.
 */
export function BriefRenderer({ content, idPrefix }: BriefRendererProps) {
  return isStructuredAnswer(content) ? (
    <StructuredAnswer content={content} idPrefix={idPrefix} />
  ) : (
    <Markdown content={content} />
  )
}
