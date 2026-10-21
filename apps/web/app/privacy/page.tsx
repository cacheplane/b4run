import type { Metadata } from "next"
import Privacy from "../../content/privacy.mdx"
import { resolveStaticSeoPage, toMetadata } from "../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/privacy"))

export default function Page() {
  return (
    <main
      id="content"
      tabIndex={-1}
      className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full"
    >
      <article className="prose-b4">
        <Privacy />
      </article>
    </main>
  )
}
