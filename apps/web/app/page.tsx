import { DeveloperHome } from "./components/homepage/DeveloperHome"
import { JsonLd } from "./seo/JsonLd"
import { resolveStaticSeoPage, toMetadata } from "./seo/resolve"
import { webPageJsonLd } from "./seo/structured-data"

const resolvedSeoPage = resolveStaticSeoPage("/")

if (resolvedSeoPage?.kind !== "WebPage") {
  throw new Error("Homepage SEO page is not registered")
}

const seoPage = resolvedSeoPage

export const metadata = toMetadata(seoPage)

export default function HomePage() {
  return (
    <>
      <JsonLd data={webPageJsonLd(seoPage)} />
      <DeveloperHome />
    </>
  )
}
