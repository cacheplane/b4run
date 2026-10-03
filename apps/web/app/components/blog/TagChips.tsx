import Link from "next/link"

interface TagChipsProps {
  readonly tags: readonly string[]
  readonly activeTag?: string
}
export function TagChips({ tags, activeTag }: TagChipsProps) {
  return (
    <nav aria-label="Filter posts by tag" className="flex gap-2 flex-wrap mb-8">
      {[
        { label: "All", href: "/blog", active: !activeTag },
        ...tags.map((tag) => ({
          label: tag,
          href: `/blog/tags/${tag}`,
          active: tag === activeTag,
        })),
      ].map((item) => (
        <Link
          key={item.href}
          href={item.href}
          data-ui="chip"
          aria-current={item.active ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
