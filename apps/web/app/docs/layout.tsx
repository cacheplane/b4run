import type { ReactNode } from "react"
import { DocsCalloutLabelsProvider } from "../components/docs/DocsCalloutLabels"
import { DocsNoScriptNav } from "../components/docs/DocsNoScriptNav"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { ReadingLayout } from "../components/ReadingLayout"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsCalloutLabelsProvider>
      <div data-docs-layout>
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
    </DocsCalloutLabelsProvider>
  )
}
