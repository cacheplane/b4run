import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/flight-planner.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/flight-planner"))

export default function Page() {
  return <DocsPage href="/docs/recipes/flight-planner" Content={Content} />
}
