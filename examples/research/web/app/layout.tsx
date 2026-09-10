import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// Required, not optional polish: the activity cards carry no inline styles, so
// without this import the plan and researcher cards render as bare markup.
// Restyle by overriding the `--b4-activity-*` tokens.
import "@b4run/ag-ui/react/styles.css"
import "./theme.css"

export const metadata = { title: "B4.run research — CopilotKit + AG-UI" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 font-sans bg-wb-bg text-wb-text">{children}</body>
    </html>
  )
}
