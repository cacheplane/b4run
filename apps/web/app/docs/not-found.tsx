import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
}

export default function DocsNotFound() {
  return (
    <div data-docs-not-found className="py-2">
      <p className="font-mono text-xs uppercase tracking-[0.07em] text-ink-muted mb-4">404</p>
      <h1 className="text-4xl md:text-5xl font-semibold text-ink mb-6 tracking-tight">
        We couldn't find that page.
      </h1>
      <p className="text-ink-muted leading-7 mb-4">
        It may have moved when the docs were reorganized. Use the sidebar or search to find it, or
        start with{" "}
        <Link href="/docs/getting-started" className="text-ink underline underline-offset-4">
          Getting Started
        </Link>
        .
      </p>
    </div>
  )
}
