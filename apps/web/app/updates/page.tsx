import type { Metadata } from "next"
import Updates from "../../content/updates.mdx"
import { UPDATES_FORM_ENABLED } from "../lib/growth/updates-enabled"
import { JsonLd } from "../seo/JsonLd"
import { UPDATES_SEO_PAGE } from "../seo/registry"
import { toMetadata } from "../seo/resolve"
import { breadcrumbJsonLd, webPageJsonLd } from "../seo/structured-data"
import { FounderUpdatesForm } from "./FounderUpdatesForm"

const page = UPDATES_SEO_PAGE
export const metadata: Metadata = toMetadata(page)

export default function Page() {
  return (
    <main
      id="content"
      tabIndex={-1}
      className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full"
    >
      <JsonLd data={webPageJsonLd(page)} />
      <JsonLd data={breadcrumbJsonLd(page)} />
      <article className="prose-b4">
        <Updates />
      </article>
      {UPDATES_FORM_ENABLED ? (
        <FounderUpdatesForm />
      ) : (
        <p>Updates are not open yet. Check back soon.</p>
      )}
    </main>
  )
}
