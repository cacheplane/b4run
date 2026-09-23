import { Card } from "../ui/Card"
import { siblingsFor } from "./nav"

interface Props {
  readonly href: string
}

export function DocsPrevNext({ href }: Props) {
  const { prev, next } = siblingsFor(href)
  if (!prev && !next) return null

  return (
    <nav aria-label="Pagination" className="mt-16 pt-8 border-t border-rule grid grid-cols-2 gap-4">
      {prev ? (
        <Card href={prev.href} className="p-4">
          <span className="text-xs text-ink-muted block mb-1">&larr; Previous</span>
          <span className="text-sm font-semibold text-ink">{prev.label}</span>
        </Card>
      ) : (
        <span />
      )}
      {next ? (
        <Card href={next.href} className="p-4 text-right">
          <span className="text-xs text-ink-muted block mb-1">Next &rarr;</span>
          <span className="text-sm font-semibold text-ink">{next.label}</span>
        </Card>
      ) : (
        <span />
      )}
    </nav>
  )
}
