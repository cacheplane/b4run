import type { ReactElement, ReactNode } from "react"

/** The muted "· …" fragment after a sentence. Renders nothing for empty content. */
export function StatusText({ children }: { readonly children: ReactNode }): ReactElement | null {
  if (children === "" || children === null || children === undefined || children === false) {
    return null
  }
  return <span className="b4-step__meta">{children}</span>
}
