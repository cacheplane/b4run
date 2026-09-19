import type { Metadata } from "next"
import Content from "../../../content/docs/approval-grants.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/approval-grants"))

export default function Page() {
  return <DocsPage href="/docs/approval-grants" Content={Content} />
}
