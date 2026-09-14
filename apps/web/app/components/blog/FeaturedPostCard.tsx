import Link from "next/link"
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
    <Link
      href={`/blog/${encodeURIComponent(post.slug)}`}
      className={`${styles.card} ${styles.featured}`}
    >
      <Eyebrow tone="accent">Essay · {post.readingTimeMinutes} min read</Eyebrow>
      <h2 className="font-display text-2xl md:text-3xl font-semibold mt-2 mb-2 tracking-tight">
        {post.title}
      </h2>
      <p className="text-base mb-4 leading-relaxed">{post.description}</p>
      <div className="text-xs">
        {formatDate(post.date)} · {author.name}
      </div>
    </Link>
  )
}
