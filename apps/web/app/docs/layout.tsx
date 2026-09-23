import type { ReactNode } from "react"
import { DocsBrandProvider } from "../components/docs/DocsBrandProvider"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"
import { ReadingLayout } from "../components/ReadingLayout"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsBrandProvider>
      <div data-docs-layout>
        <ReadingLayout
          left={<DocsSidebar searchIndex={DOCS_INDEX} />}
          leftLabel="Docs sidebar"
          right={<DocsTOC />}
          rightLabel="Page contents"
        >
          {children}
        </ReadingLayout>
      </div>
    </DocsBrandProvider>
  )
}
