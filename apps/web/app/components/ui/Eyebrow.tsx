import type { ReactNode } from "react"

type Tone = "muted" | "olive" | "panel"

interface EyebrowProps {
  readonly children: ReactNode
  /** muted on paper (default), olive for a highlighted label, panel on the dark panel. */
  readonly tone?: Tone
  /** Optional; `string | undefined` so a CSS-module lookup can be passed straight through. */
  readonly className?: string | undefined
}

/** The one eyebrow: JetBrains Mono 12px, uppercase, 0.07em (ui.css). */
export function Eyebrow({ children, tone = "muted", className }: EyebrowProps) {
  return (
    <p data-ui="eyebrow" data-tone={tone} {...(className ? { className } : {})}>
      {children}
    </p>
  )
}
