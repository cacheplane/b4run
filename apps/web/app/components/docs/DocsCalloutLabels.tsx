"use client"

import { createContext, type ReactNode, useContext } from "react"

/**
 * Docs pages label their untitled callouts ("Info", "Tip", …); the same
 * Callout elsewhere (blog, homepage) renders without one. The docs layout
 * mounts the provider, and Callout asks for the label.
 */
const DocsCalloutLabelsContext = createContext(false)

export function DocsCalloutLabelsProvider({ children }: { readonly children: ReactNode }) {
  return (
    <DocsCalloutLabelsContext.Provider value={true}>{children}</DocsCalloutLabelsContext.Provider>
  )
}

export function DocsCalloutLabel({ type }: { readonly type: "info" | "tip" | "warn" | "danger" }) {
  const docs = useContext(DocsCalloutLabelsContext)
  if (!docs) return null
  const labels = { info: "Info", tip: "Tip", warn: "Warning", danger: "Danger" }
  return <p data-callout-label>{labels[type]}</p>
}
