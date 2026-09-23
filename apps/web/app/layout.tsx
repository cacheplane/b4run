import type { Metadata } from "next"
import { Inter, JetBrains_Mono } from "next/font/google"
import type { ReactNode } from "react"
import { Footer } from "./components/Footer"
import { Header } from "./components/Header"
import { JsonLd } from "./seo/JsonLd"
import { SOCIAL_CARD, SOCIAL_SITE_NAME } from "./seo/social"
import { siteJsonLd } from "./seo/structured-data"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

// A metric-adjusted fallback is Arial, which is proportional. A real monospace
// fallback has the same advance width, so the swap does not move text.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
})

export const metadata: Metadata = {
  metadataBase: new URL("https://b4.run"),
  applicationName: "B4.run",
  title: {
    default: "B4.run: the TypeScript meta-framework for LangGraph.js",
    template: "%s | B4.run",
  },
  description:
    "B4.run adds file-system routing, route-local tools, generated types, and HMR to your LangGraph.js stack. You keep the runtime and skip the boilerplate.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon-64x64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    url: "https://b4.run",
    siteName: SOCIAL_SITE_NAME,
    title: "B4.run: the TypeScript meta-framework for LangGraph.js",
    description:
      "B4.run adds file-system routing, route-local tools, generated types, and HMR to your LangGraph.js stack. You keep the runtime and skip the boilerplate.",
    // Image is provided by app/opengraph-image.tsx (1200×630, cream palette).
  },
  twitter: {
    card: SOCIAL_CARD,
    title: "B4.run: the TypeScript meta-framework for LangGraph.js",
    description:
      "B4.run adds file-system routing, route-local tools, generated types, and HMR to your LangGraph.js stack. You keep the runtime and skip the boilerplate.",
    // Image is provided by app/twitter-image.tsx (re-exports opengraph-image).
  },
  appleWebApp: {
    title: "B4.run",
    capable: true,
    statusBarStyle: "default",
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <JsonLd data={siteJsonLd()} />
        <div className="min-h-screen flex flex-col">
          <Header />
          {/* Each page renders its own <main id="content">: reading layouts
              wrap only the article column, so the sidebar and TOC asides sit
              beside the main landmark instead of inside it. */}
          <div className="flex-1 flex flex-col">{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  )
}
