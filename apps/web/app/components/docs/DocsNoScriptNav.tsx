import { DOCS_NAV } from "./nav"

/**
 * Below md the docs nav lives in the header's menu dialog, which needs
 * JavaScript. Without it, this plain disclosure of links stands in; with
 * JavaScript the `<noscript>` content is never rendered.
 */
export function DocsNoScriptNav() {
  return (
    <noscript>
      <details data-docs-noscript-nav className="md:hidden mb-6 rounded-md border border-divider">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs uppercase tracking-widest text-ink-muted">
          Documentation menu
        </summary>
        <nav aria-label="Documentation" className="border-t border-divider px-3 py-2">
          {DOCS_NAV.map((section) => (
            <div key={section.label} className="py-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                {section.label}
              </p>
              <ul>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      className="flex min-h-11 items-center text-sm text-ink-muted"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </details>
    </noscript>
  )
}
