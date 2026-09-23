import type { ReactNode } from "react"

type Tone = "muted" | "olive" | "panel"

interface EyebrowProps {
  readonly children: ReactNode
  /**
   * muted on paper (default), olive for an accent label, panel on the dark panel.
   * `accent` is the pre-design-system spelling of `olive`, kept only until the
   * blog components migrate (Task 7); remove it then.
   */
  readonly tone?: Tone | "accent"
  readonly className?: string
}

/** The one eyebrow: JetBrains Mono 12px, uppercase, 0.07em (ui.css). */
export function Eyebrow({ children, tone = "muted", className }: EyebrowProps) {
  const resolved: Tone = tone === "accent" ? "olive" : tone
  return (
    <p data-ui="eyebrow" data-tone={resolved} {...(className ? { className } : {})}>
      {children}
    </p>
  )
}
