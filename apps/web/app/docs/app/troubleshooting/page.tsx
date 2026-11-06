import type { Metadata } from "next"
import Content from "../../../../content/docs/app/troubleshooting.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/app/troubleshooting"))
export default function Page() {
  return <DocsPage href="/docs/app/troubleshooting" Content={Content} />
}
