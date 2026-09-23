import Link, { type LinkProps } from "next/link"
import type { AnchorHTMLAttributes, ReactNode } from "react"

/**
 * next/link redeclares these three handlers without `| undefined`, so under
 * exactOptionalPropertyTypes they must come from LinkProps to spread into both branches.
 */
type LinkHandlers = "onClick" | "onMouseEnter" | "onTouchStart"

interface SiteLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | LinkHandlers>,
    Pick<LinkProps, LinkHandlers> {
  readonly href: string
  readonly children: ReactNode
}

/** `http(s)://` hrefs leave the site and open in a new tab. */
function isExternalHref(href: string): boolean {
  return /^https?:\/\//.test(href)
}

/**
 * Internal hrefs get next/link; off-site hrefs open in a new tab. A caller's
 * `target` (which wins over the injected `_blank`) or `download` forces a plain
 * anchor, as does `mailto:`, which gets no target: a blank tab would be left
 * behind when a desktop mail client handles it. The ↗ is drawn by ui.css from
 * the href, so this component never writes it.
 */
export function SiteLink({ href, children, ...rest }: SiteLinkProps) {
  const external = isExternalHref(href)
  if (
    external ||
    href.startsWith("mailto:") ||
    rest.target !== undefined ||
    rest.download !== undefined
  ) {
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...rest}
      >
        {children}
      </a>
    )
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  )
}
