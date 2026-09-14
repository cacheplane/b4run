import type { Metadata } from "next"
import type { ReactNode } from "react"

import styles from "../components/blog/blog.module.css"

export const metadata: Metadata = {
  title: { default: "Blog", template: "%s | B4.run Blog" },
  description: "Writing on the agent stack, type-safety, and the tools we're building.",
  alternates: {
    types: { "application/rss+xml": "/blog/rss.xml" },
  },
}

export default function BlogLayout({ children }: { children: ReactNode }) {
  return <div className={styles.blog}>{children}</div>
}
