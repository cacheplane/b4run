import type { CtaId } from "../lib/analytics/events"
import { BrandLogo } from "./BrandLogo"
import headerStyles from "./homepage/header.module.css"
import { NAVLOG_DEMO_URL } from "./site-links"
import { Eyebrow } from "./ui/Eyebrow"
import { SiteLink } from "./ui/SiteLink"

interface LinkItem {
  readonly label: string
  readonly href: string
  /** Same-origin files (RSS, llms.txt) must bypass the client router and open in a new tab. */
  readonly target?: "_blank"
  /** Gives the link a call-to-action id for click signals. */
  readonly ctaId?: CtaId
}

interface Column {
  readonly heading: string
  readonly items: readonly LinkItem[]
}

const COLUMNS: readonly Column[] = [
  {
    heading: "Product",
    items: [
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Examples", href: "https://github.com/cacheplane/b4run/tree/main/examples" },
      { label: "Live demo", href: NAVLOG_DEMO_URL, ctaId: "footer_live_demo" },
      { label: "Blog", href: "/blog" },
      { label: "Updates", href: "/updates", ctaId: "footer_updates" },
    ],
  },
  {
    heading: "Resources",
    items: [
      { label: "GitHub", href: "https://github.com/cacheplane/b4run", ctaId: "footer_github" },
      { label: "npm", href: "https://www.npmjs.com/org/b4run", ctaId: "footer_npm" },
      { label: "LangGraph.js", href: "https://www.langchain.com/langgraph" },
      { label: "RSS feed", href: "/blog/rss.xml", target: "_blank", ctaId: "footer_rss" },
      { label: "llms.txt", href: "/llms.txt", target: "_blank" },
    ],
  },
  {
    heading: "Legal",
    items: [
      { label: "Privacy", href: "/privacy" },
      { label: "MIT License", href: "https://github.com/cacheplane/b4run/blob/main/LICENSE" },
      {
        label: "Code of Conduct",
        href: "https://github.com/cacheplane/b4run/blob/main/CODE_OF_CONDUCT.md",
      },
      { label: "Security", href: "https://github.com/cacheplane/b4run/blob/main/SECURITY.md" },
    ],
  },
]

function FooterLink({ label, href, target, ctaId }: LinkItem) {
  return (
    <SiteLink
      href={href}
      {...(target !== undefined ? { target } : {})}
      {...(ctaId !== undefined ? { "data-cta-id": ctaId } : {})}
      className="text-sm text-ink-muted hover:text-ink transition-colors block py-0.5"
    >
      {label}
    </SiteLink>
  )
}

export function Footer() {
  return (
    <footer data-site-footer data-signal-surface="footer" className="bg-page border-t border-rule">
      <div className={`${headerStyles.column} pt-16 pb-10`}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-8">
          <div className="col-span-2 md:col-span-1">
            <BrandLogo imageClassName="h-7" variant="dark" />
            <p className="text-sm text-ink-muted mt-3 leading-relaxed max-w-[28ch]">
              An agent framework, the way I'd build it.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-1">
              <Eyebrow className="mb-3">{col.heading}</Eyebrow>
              {col.items.map((item) => (
                <FooterLink key={item.label} {...item} />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-12 pt-6 border-t border-rule flex flex-col md:flex-row gap-2 md:justify-between text-xs text-ink-muted">
          <span>{`© ${new Date().getFullYear()} B4.run. MIT-licensed.`}</span>
          <span>
            Made with{" "}
            <SiteLink
              href="https://brianflove.com"
              className="underline decoration-olive underline-offset-4 hover:text-ink"
            >
              b-love
            </SiteLink>
            . Built on the LangChain ecosystem.
          </span>
        </div>
      </div>
    </footer>
  )
}
