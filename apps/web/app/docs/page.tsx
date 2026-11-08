import type { Metadata } from "next"
import Link from "next/link"
import { JsonLd } from "../seo/JsonLd"
import { DOCS_HOME_SEO_PAGE } from "../seo/registry"
import { toMetadata } from "../seo/resolve"
import { breadcrumbJsonLd, webPageJsonLd } from "../seo/structured-data"

const page = DOCS_HOME_SEO_PAGE
export const metadata: Metadata = toMetadata(page)
export default function DocsHome() {
  return (
    <article className="prose-b4">
      <JsonLd data={webPageJsonLd(page)} />
      <JsonLd data={breadcrumbJsonLd(page)} />
      <h1>Documentation</h1>
      <p>Start with the work you want to do.</p>
      <section className="border-t border-rule py-6">
        <h2>
          <Link href="/docs/app">Use the app</Link>
        </h2>
        <p>
          Work with your agents on your Mac and follow your conversations from your iPhone. Start
          with an agent you already use.
        </p>
        <p>
          <Link href="/docs/app">Explore the app guides</Link>
        </p>
      </section>
      <section className="border-t border-rule py-6">
        <h2>
          <Link href="/docs/getting-started">Build with B4</Link>
        </h2>
        <p>Create, test, and deploy agents. Connect them to the app or build your own interface.</p>
        <p>
          <Link href="/docs/getting-started">Start with the framework</Link>
        </p>
      </section>
    </article>
  )
}
