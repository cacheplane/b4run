"use client"

import { createContext, type ReactNode, useContext } from "react"

const DocsBrandContext = createContext(false)

export function DocsBrandProvider({ children }: { readonly children: ReactNode }) {
  return <DocsBrandContext.Provider value={true}>{children}</DocsBrandContext.Provider>
}

export function DocsCalloutLabel({ type }: { readonly type: "info" | "tip" | "warn" | "danger" }) {
  const docs = useContext(DocsBrandContext)
  if (!docs) return null
  const labels = { info: "Info", tip: "Tip", warn: "Warning", danger: "Danger" }
  return <p data-callout-label>{labels[type]}</p>
}
