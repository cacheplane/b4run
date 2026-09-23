import Image from "next/image"
import Link from "next/link"
import { Eyebrow } from "../ui/Eyebrow"
import { AUTHORS, type Author, type Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function PostHeader({ post }: { readonly post: Post }) {
  const eyebrow =
    post.type === "release"
      ? `Release · v${post.version}`
      : `Essay · ${post.readingTimeMinutes} min read`
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <header className="mb-8 pb-8 border-b border-rule">
      <div className="mb-2">
        <Eyebrow tone="olive">{eyebrow}</Eyebrow>
      </div>
      <h1 className="text-h1 text-ink mb-3">{post.title}</h1>
      <p className="text-lg text-ink-muted leading-relaxed">{post.description}</p>
      <div className="text-sm text-ink-muted mt-4">{formatDate(post.date)}</div>

      {/* Mobile-only: author byline + tags. Desktop sees these in the PostMeta left rail. */}
      <div className="md:hidden mt-5 flex items-center gap-3">
        <Image src={author.avatar} alt={author.name} width={28} height={28} />
        <a href={author.url} target="_blank" rel="noopener noreferrer" className="text-sm">
          {author.name}
        </a>
      </div>
      {post.tags.length > 0 && (
        <div className="md:hidden mt-3 flex flex-wrap gap-1.5">
          {post.tags.map((tag) => (
            <Link key={tag} href={`/blog/tags/${tag}`} data-ui="chip">
              {tag}
            </Link>
          ))}
        </div>
      )}
    </header>
  )
}
