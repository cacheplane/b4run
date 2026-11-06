import type { Metadata } from "next"
import Content from "../../../../content/docs/app/b4-agents.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/b4-agents"))
export default function Page() {
  return <DocsPage href="/docs/app/b4-agents" Content={Content} />
}
