import Link from "next/link"
import styles from "./blog.module.css"

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
          aria-current={item.active ? "page" : undefined}
          className={`${styles.chip} ${item.active ? styles.active : ""}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
