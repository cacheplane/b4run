import Link from "next/link"
import { breadcrumbsFor } from "./nav"

interface Props {
  readonly href: string
}

export function DocsBreadcrumb({ href }: Props) {
  const crumbs = breadcrumbsFor(href)
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-ink-muted">
      <ol className="flex items-center gap-2 flex-wrap">
        {crumbs.map((c, i) => (
          <li key={c.href ?? c.label} className="flex items-center gap-2">
            {c.href ? (
              <Link
                href={c.href}
                className="inline-flex min-h-11 items-center md:min-h-0 hover:text-ink transition-colors"
              >
                {c.label}
              </Link>
            ) : (
              <span
                className="text-ink-muted"
                {...(i === crumbs.length - 1 ? { "aria-current": "page" as const } : {})}
              >
                {c.label}
              </span>
            )}
            {i < crumbs.length - 1 && <span aria-hidden>/</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}
