import type { Metadata } from "next"
import Content from "../../../../content/docs/app/first-conversation.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/first-conversation"))
export default function Page() {
  return <DocsPage href="/docs/app/first-conversation" Content={Content} />
}
