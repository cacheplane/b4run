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

// CopilotChat's dark mode is `.dark`-only (its tokens sit on `.dark
// [data-copilotkit]` and its `cpk:dark:` utilities compile to `:is(.dark *)`),
// while this app's dark theme is a media query. Mirror the media query onto
// `<html class="dark">` before first paint and keep it in sync.
const DARK_CLASS_SCRIPT = `(function(){try{var m=matchMedia("(prefers-color-scheme: dark)"),r=document.documentElement,t=function(){r.classList.toggle("dark",m.matches)};t();m.addEventListener("change",t)}catch(e){}})()`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script adds `class="dark"` before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static constant, no user input */}
        <script dangerouslySetInnerHTML={{ __html: DARK_CLASS_SCRIPT }} />
      </head>
      <body className="m-0 font-sans bg-wb-bg text-wb-text">{children}</body>
    </html>
  )
}
