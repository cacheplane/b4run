import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/navlog.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/navlog"))

export default function Page() {
  return <DocsPage href="/docs/recipes/navlog" Content={Content} />
}
