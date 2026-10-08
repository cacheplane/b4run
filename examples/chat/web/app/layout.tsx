import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// The activity kit's default look, light and dark. Restyle by overriding the
// `--b4-activity-*` tokens in your own CSS.
import "@b4run/ag-ui/styles.css"

export const metadata = { title: "B4.run chat — CopilotKit + AG-UI" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  )
}
