import type { Viewport } from "next"
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google"
import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// Required, not optional polish: the activity kit carries no inline styles, so
// without this import each turn's plan, steps and subagents render as bare markup.
// Restyle by overriding the `--b4-activity-*` tokens.
import "@b4run/ag-ui/styles.css"
import "leaflet/dist/leaflet.css"
import "./theme.css"

export const metadata = { title: "B4.run navlog — a C172N VFR flight planner" }

// LiveLoveApp's two faces. `theme.css` maps these variables onto Tailwind's
// `font-sans` / `font-mono`, CopilotChat's `--cpk-font-*` and the activity
// kit's `--b4-activity-font-mono`.
const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" })
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" })

// `viewport-fit=cover` so the phone's tab bar can pad itself clear of the
// home indicator (`env(safe-area-inset-bottom)` is 0 without it); the theme
// color matches `--wb-bg` so the browser chrome blends with the app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f4f5",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Light only. `data-b4-theme="light"` pins the activity kit's own tokens
    // to light even when the OS is dark.
    <html lang="en" data-b4-theme="light" className={`${sans.variable} ${mono.variable}`}>
      <body className="m-0 font-sans bg-wb-bg text-wb-text">{children}</body>
    </html>
  )
}
