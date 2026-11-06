import type { Metadata } from "next"
import Content from "../../../../content/docs/app/claude-code.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/claude-code"))
export default function Page() {
  return <DocsPage href="/docs/app/claude-code" Content={Content} />
}
