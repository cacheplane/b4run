import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// The whole default tier: one import gives B4.run's plan and subagent activity
// cards their identity in light and dark. Restyle by overriding the
// `--b4-activity-*` tokens; see the package README for the full ladder.
import "@b4run/ag-ui/react/styles.css"

export const metadata = { title: "B4.run chat — CopilotKit + AG-UI" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  )
}
