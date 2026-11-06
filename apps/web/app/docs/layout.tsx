import { Hanken_Grotesk } from "next/font/google"
import type { ReactNode } from "react"
import { DocsCalloutLabelsProvider } from "../components/docs/DocsCalloutLabels"
import { DocsNoScriptNav } from "../components/docs/DocsNoScriptNav"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import styles from "../components/docs/docs-identity.module.css"
import { ReadingLayout } from "../components/ReadingLayout"

const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" })

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsCalloutLabelsProvider>
      <div data-docs-layout className={`${hanken.variable} ${styles.docs}`}>
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
