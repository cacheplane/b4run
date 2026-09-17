import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/vercel.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/deployment/vercel"))

export default function Page() {
  return <DocsPage href="/docs/deployment/vercel" Content={Content} />
}
