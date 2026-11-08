import type { Metadata } from "next"
import Content from "../../../../content/docs/app/accounts-and-data.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/accounts-and-data"))
export default function Page() {
  return <DocsPage href="/docs/app/accounts-and-data" Content={Content} />
}
