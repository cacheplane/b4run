import type { Metadata } from "next"
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google"
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

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT", "WONK"],
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://b4.run"),
  applicationName: "B4.run",
  title: {
    default: "B4.run — TypeScript meta-framework for LangGraph.js",
    template: "%s | B4.run",
  },
  description:
    "B4.run adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
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
    title: "B4.run — TypeScript meta-framework for LangGraph.js",
    description:
      "B4.run adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
    // Image is provided by app/opengraph-image.tsx (1200×630, cream palette).
  },
  twitter: {
    card: SOCIAL_CARD,
    title: "B4.run — TypeScript meta-framework for LangGraph.js",
    description:
      "B4.run adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
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
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}>
      <body>
        <JsonLd data={siteJsonLd()} />
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  )
}
