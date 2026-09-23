import type { ReactNode } from "react"
import { DocsCalloutLabel } from "../docs/DocsBrandProvider"

type CalloutType = "info" | "tip" | "warn" | "danger"

interface Props {
  readonly type?: CalloutType
  readonly title?: string
  readonly children: ReactNode
}

const GLYPH: Record<CalloutType, string> = {
  info: "ⓘ", // ⓘ
  tip: "✨", // ✨
  warn: "⚠", // ⚠
  danger: "✖", // ✖
}

/** Colours and borders come from ui.css [data-callout-type]. */
export function Callout({ type = "info", title, children }: Props) {
  return (
    <aside data-callout-type={type} className="my-6 flex gap-3 items-start" role="note">
      <span className="text-base mt-0.5 shrink-0" aria-hidden>
        {GLYPH[type]}
      </span>
      <div className="flex-1 min-w-0">
        <DocsCalloutLabel type={type} />
        {title && <p className="font-semibold text-ink mb-1 text-sm">{title}</p>}
        <div className="text-sm text-ink-muted leading-relaxed [&>p]:m-0 [&>p+p]:mt-2">
          {children}
        </div>
      </div>
    </aside>
  )
}
