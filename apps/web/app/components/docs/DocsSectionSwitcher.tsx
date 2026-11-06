import Link from "next/link"
import { DOCS_AREAS, docsArea } from "./doc-sections"

export function DocsSectionSwitcher({
  pathname,
  onNavigate,
}: {
  readonly pathname: string
  readonly onNavigate?: () => void
}) {
  const active = docsArea(pathname)
  return (
    <nav aria-label="Documentation audience" className="mb-5 flex gap-2 border-b border-rule pb-3">
      {DOCS_AREAS.map((area) => (
        <Link
          key={area.id}
          href={area.href}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          {...(active === area.id ? { "aria-current": "true" as const } : {})}
          className={`inline-flex min-h-11 items-center px-3 text-sm font-semibold ${active === area.id ? "bg-relay-tint text-relay-ink" : "text-ink-muted hover:text-ink"}`}
        >
          {area.label}
        </Link>
      ))}
    </nav>
  )
}
