import type { Metadata } from "next"
import headerStyles from "./components/homepage/header.module.css"
import { Eyebrow } from "./components/ui/Eyebrow"
import { SiteLink } from "./components/ui/SiteLink"

export const metadata: Metadata = {
  title: "Page not found",
  description: "We couldn't find that page. Try the docs, blog, or the homepage.",
}

interface DestinationProps {
  readonly href: string
  readonly label: string
  readonly download?: boolean
}

const linkClass =
  "inline-flex items-center gap-1.5 min-h-11 text-sm font-medium underline underline-offset-[5px] decoration-olive hover:decoration-2"

function Destination({ href, label, download }: DestinationProps) {
  return (
    <SiteLink href={href} className={linkClass} {...(download ? { download: true } : {})}>
      {label} <span aria-hidden="true">→</span>
    </SiteLink>
  )
}

// Homepage column (header.module.css), so the page lines up with the header
// logo and footer at every width.
export default function NotFound() {
  return (
    <main id="content" tabIndex={-1} data-not-found className="flex-1 bg-page text-ink">
      <div className={`${headerStyles.column} py-24 md:py-32`}>
        <Eyebrow>404</Eyebrow>
        <h1 className="mt-5 text-display text-balance">We couldn't find that page.</h1>
        <p className="mt-6 text-body-lg text-ink-muted max-w-[52ch]">
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
            <Destination
              href="/brand/b4-run-brand-assets.zip"
              label="Download brand kit"
              download
            />
          </li>
        </ul>
      </div>
    </main>
  )
}
