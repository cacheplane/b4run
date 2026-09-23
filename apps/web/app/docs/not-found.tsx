import type { Metadata } from "next"
import Link from "next/link"
import { Eyebrow } from "../components/ui/Eyebrow"

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
}

export default function DocsNotFound() {
  return (
    <div data-docs-not-found className="py-2">
      <Eyebrow className="mb-4">404</Eyebrow>
      <h1 className="text-h1 text-ink mb-6">We couldn't find that page.</h1>
      <p className="text-ink-muted leading-7 mb-4">
        It may have moved when the docs were reorganized. Use the sidebar or search to find it, or
        start with{" "}
        <Link
          href="/docs/getting-started"
          className="text-ink underline underline-offset-4 decoration-olive"
        >
          Getting Started
        </Link>
        .
      </p>
    </div>
  )
}
