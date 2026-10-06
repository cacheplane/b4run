import type { Viewport } from "next"
import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// Required, not optional polish: the activity cards carry no inline styles, so
// without this import the plan and subagent cards render as bare markup.
// Restyle by overriding the `--b4-activity-*` tokens.
import "@b4run/ag-ui/react/styles.css"
import "leaflet/dist/leaflet.css"
import "./theme.css"

export const metadata = { title: "B4.run navlog — a C172N VFR flight planner" }

// `viewport-fit=cover` so the phone's bottom sheet can pad itself clear of the
// home indicator (`env(safe-area-inset-bottom)` is 0 without it); the theme
// colors match `--wb-bg` so the browser chrome blends with the app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0d10" },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 font-sans bg-wb-bg text-wb-text">{children}</body>
    </html>
  )
}
