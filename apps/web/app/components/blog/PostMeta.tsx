import Image from "next/image"
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

export function PostMeta({ post }: { readonly post: Post }) {
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <div className="flex flex-col gap-6 text-sm">
      <div>
        <Eyebrow className="mb-2">Published</Eyebrow>
        <div className="text-ink">{formatDate(post.date)}</div>
      </div>
      <div>
        <Eyebrow className="mb-2">Reading time</Eyebrow>
        <div className="text-ink">{post.readingTimeMinutes} min</div>
      </div>
      {post.tags.length > 0 && (
        <div>
          <Eyebrow className="mb-2">Tags</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {post.tags.map((tag) => (
              <Link key={tag} href={`/blog/tags/${tag}`} className={styles.chip}>
                {tag}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="pt-4 border-t border-rule">
        <Eyebrow className="mb-2">Author</Eyebrow>
        <div className="flex items-center gap-3">
          <Image src={author.avatar} alt={author.name} width={28} height={28} />
          <a
            href={author.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink underline decoration-olive underline-offset-4"
          >
            {author.name}
          </a>
        </div>
      </div>
    </div>
  )
}
