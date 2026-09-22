import type { Metadata } from "next"
import Link from "next/link"
import headerStyles from "./components/homepage/header.module.css"

export const metadata: Metadata = {
  title: "Page not found",
  description: "We couldn't find that page. Try the docs, blog, or the homepage.",
}

interface DestinationProps {
  readonly href: string
  readonly label: string
}

const linkClass =
  "inline-flex items-center gap-1.5 min-h-11 text-sm font-medium underline underline-offset-[5px] decoration-[#b4ce37] hover:decoration-2"

function Destination({ href, label }: DestinationProps) {
  return (
    <Link href={href} className={linkClass}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  )
}

// Homepage palette and column (header.module.css), so the page lines up with
// the header logo and footer at every width.
export default function NotFound() {
  return (
    <section data-not-found className="bg-[#f5f4f0] text-[#111]">
      <div className={`${headerStyles.column} py-24 md:py-32`}>
        <p className="font-mono text-xs uppercase tracking-[0.07em] leading-[1.6] text-[#595b53]">
          404
        </p>
        <h1 className="mt-5 font-sans font-semibold text-[40px] md:text-[64px] leading-[1.05] tracking-[-0.045em] text-balance">
          We couldn't find that page.
        </h1>
        <p className="mt-6 text-[17px] leading-[1.65] text-[#595b53] max-w-[52ch]">
          The page may have moved, or the link you followed is out of date. Try one of these
          instead:
        </p>
        <ul className="mt-6 flex flex-wrap gap-x-8">
          <li>
            <Destination href="/" label="Home" />
          </li>
          <li>
            <Destination href="/docs/getting-started" label="Read the docs" />
          </li>
          <li>
            <Destination href="/blog" label="Latest from the blog" />
          </li>
          <li>
            <a href="/brand/b4-run-brand-assets.zip" download className={linkClass}>
              Download brand kit <span aria-hidden="true">→</span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  )
}
