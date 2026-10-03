import type { Metadata } from "next"
import { notFound } from "next/navigation"

// Unknown docs URLs render the docs 404 inside the docs layout. Rendering it
// here, rather than falling through to the site-wide prerendered 404, means the
// server sees the real /docs path, so the header and layout hydrate cleanly.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
}

export default function UnknownDocsPage(): never {
  notFound()
}
