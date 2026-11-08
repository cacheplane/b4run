import type { Metadata } from "next"
import Content from "../../../../content/docs/app/install.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/install"))
export default function Page() {
  return <DocsPage href="/docs/app/install" Content={Content} />
}
