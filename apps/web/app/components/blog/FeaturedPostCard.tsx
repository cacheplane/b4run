import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"
import styles from "./blog.module.css"
import { AUTHORS, type Author, type Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function FeaturedPostCard({ post }: { readonly post: Post }) {
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <Card
      href={`/blog/${encodeURIComponent(post.slug)}`}
      className={`${styles.card} ${styles.featured}`}
    >
      <Eyebrow tone="tint">Essay · {post.readingTimeMinutes} min read</Eyebrow>
      <h2 className="text-h2 mt-2 mb-2">{post.title}</h2>
      <p className="text-base mb-4 leading-relaxed">{post.description}</p>
      <div className="text-xs">
        {formatDate(post.date)} · {author.name}
      </div>
    </Card>
  )
}
