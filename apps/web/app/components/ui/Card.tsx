import Link from "next/link"
import type { ReactNode } from "react"

interface CardProps {
  readonly children: ReactNode
  readonly href?: string
  /** Optional; `string | undefined` so a CSS-module lookup can be passed straight through. */
  readonly className?: string | undefined
}

/** A bordered paper block; a link card when given an href (hover = relay tint). */
export function Card({ children, href, className }: CardProps) {
  const attrs = { "data-ui": "card", ...(className ? { className } : {}) }
  if (href !== undefined) {
    return (
      <Link {...attrs} href={href}>
        {children}
      </Link>
    )
  }
  return <div {...attrs}>{children}</div>
}
