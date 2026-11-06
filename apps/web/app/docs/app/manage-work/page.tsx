import type { Metadata } from "next"
import Content from "../../../../content/docs/app/manage-work.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/manage-work"))
export default function Page() {
  return <DocsPage href="/docs/app/manage-work" Content={Content} />
}
