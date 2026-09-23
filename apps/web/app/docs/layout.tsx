import type { ReactNode } from "react"
import { DocsBrandProvider } from "../components/docs/DocsBrandProvider"
import { DocsNoScriptNav } from "../components/docs/DocsNoScriptNav"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { ReadingLayout } from "../components/ReadingLayout"
import "./docs-brand.css"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsBrandProvider>
      <div data-docs-brand data-docs-layout>
        <ReadingLayout
          left={<DocsSidebar />}
          leftLabel="Docs sidebar"
          right={<DocsTOC />}
          rightLabel="Page contents"
        >
          <DocsNoScriptNav />
          {children}
        </ReadingLayout>
      </div>
    </DocsBrandProvider>
  )
}
