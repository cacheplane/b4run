import type { Metadata } from "next"
import Updates from "../../content/updates.mdx"
import { UPDATES_FORM_ENABLED } from "../lib/growth/updates-enabled"
import { resolveStaticSeoPage, toMetadata } from "../seo/resolve"
import { FounderUpdatesForm } from "./FounderUpdatesForm"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/updates"))

export default function Page() {
  return (
    <main
      id="content"
      tabIndex={-1}
      className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full"
    >
      <article className="prose-b4">
        <Updates />
      </article>
      {UPDATES_FORM_ENABLED ? (
        <FounderUpdatesForm />
      ) : (
        <p>Updates are not open yet. Check back soon.</p>
      )}
    </main>
  )
}
