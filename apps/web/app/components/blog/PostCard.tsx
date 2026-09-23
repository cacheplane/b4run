import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"
import styles from "./blog.module.css"
import type { Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function PostCard({ post }: { readonly post: Post }) {
  const isRelease = post.type === "release"
  return (
    <Card href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.card}>
      {isRelease ? (
        <span className={styles.version}>v{post.version}</span>
      ) : (
        <Eyebrow>Essay · {post.readingTimeMinutes} min</Eyebrow>
      )}
      <h3 className="text-lg font-semibold text-ink mt-2 mb-1 leading-snug">{post.title}</h3>
      <p className="text-sm text-ink-muted leading-relaxed mb-3">{post.description}</p>
      <div className="text-xs text-ink-muted">{formatDate(post.date)}</div>
    </Card>
  )
}
