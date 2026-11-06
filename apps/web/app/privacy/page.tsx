import type { Metadata } from "next"
import Privacy from "../../content/privacy.mdx"
import { JsonLd } from "../seo/JsonLd"
import { PRIVACY_SEO_PAGE } from "../seo/registry"
import { toMetadata } from "../seo/resolve"
import { breadcrumbJsonLd, webPageJsonLd } from "../seo/structured-data"

const page = PRIVACY_SEO_PAGE
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
        <Privacy />
      </article>
    </main>
  )
}
