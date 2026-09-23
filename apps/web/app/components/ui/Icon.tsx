import type { ReactNode, SVGProps } from "react"

const GLYPHS = {
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M6 18L18 6" />,
  arrowUpRight: (
    <>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof GLYPHS

export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[]

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  readonly name: IconName
  /** sm = 16px, md = 20px. Stroke is 1.5 at both sizes. */
  readonly size?: "sm" | "md"
}

/** Decorative by default; give the parent control its accessible name. */
export function Icon({ name, size = "sm", ...rest }: IconProps) {
  return (
    <svg
      data-ui="icon"
      data-size={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  )
}
