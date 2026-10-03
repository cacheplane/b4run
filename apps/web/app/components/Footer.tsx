import { BrandLogo } from "./BrandLogo"
import headerStyles from "./homepage/header.module.css"
import { Eyebrow } from "./ui/Eyebrow"
import { SiteLink } from "./ui/SiteLink"

interface LinkItem {
  readonly label: string
  readonly href: string
  /** Same-origin files (RSS, llms.txt) must bypass the client router and open in a new tab. */
  readonly target?: "_blank"
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
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    heading: "Resources",
    items: [
      { label: "GitHub", href: "https://github.com/cacheplane/b4run" },
      { label: "npm", href: "https://www.npmjs.com/org/b4run" },
      { label: "LangGraph.js", href: "https://www.langchain.com/langgraph" },
      { label: "RSS feed", href: "/blog/rss.xml", target: "_blank" },
      { label: "llms.txt", href: "/llms.txt", target: "_blank" },
    ],
  },
  {
    heading: "Legal",
    items: [
      { label: "MIT License", href: "https://github.com/cacheplane/b4run/blob/main/LICENSE" },
      {
        label: "Code of Conduct",
        href: "https://github.com/cacheplane/b4run/blob/main/CODE_OF_CONDUCT.md",
      },
      { label: "Security", href: "https://github.com/cacheplane/b4run/blob/main/SECURITY.md" },
    ],
  },
]

function FooterLink({ label, href, target }: LinkItem) {
  return (
    <SiteLink
      href={href}
      {...(target !== undefined ? { target } : {})}
      className="text-sm text-ink-muted hover:text-ink transition-colors block py-0.5"
    >
      {label}
    </SiteLink>
  )
}

export function Footer() {
  return (
    <footer data-site-footer className="bg-page border-t border-rule">
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
