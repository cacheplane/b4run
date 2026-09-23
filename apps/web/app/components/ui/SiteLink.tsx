import Link, { type LinkProps } from "next/link"
import type { AnchorHTMLAttributes, ReactNode } from "react"

/** next/link redeclares these three handlers without `| undefined`, so under
    exactOptionalPropertyTypes they must come from LinkProps to spread into both branches. */
type LinkHandlers = "onClick" | "onMouseEnter" | "onTouchStart"

interface SiteLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | LinkHandlers>,
    Pick<LinkProps, LinkHandlers> {
  readonly href: string
  readonly children: ReactNode
}

export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || href.startsWith("mailto:")
}

/** Internal hrefs get next/link; off-site hrefs open in a new tab. The ↗ is
    drawn by ui.css from the href, so this component never writes it. */
export function SiteLink({ href, children, ...rest }: SiteLinkProps) {
  if (isExternalHref(href) || rest.download !== undefined) {
    return (
      <a
        href={href}
        {...(isExternalHref(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
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
