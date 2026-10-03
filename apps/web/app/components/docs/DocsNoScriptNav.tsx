import { Eyebrow } from "../ui/Eyebrow"
import { DOCS_NAV } from "./nav"

/**
 * Below md the docs nav lives in the header's menu dialog, which needs
 * JavaScript. Without it, this plain disclosure of links stands in; with
 * JavaScript the `<noscript>` content is never rendered.
 */
export function DocsNoScriptNav() {
  return (
    <noscript>
      <details data-docs-noscript-nav className="md:hidden mb-6 border border-rule">
        <summary className="flex min-h-11 cursor-pointer items-center px-3">
          <Eyebrow as="span">Documentation menu</Eyebrow>
        </summary>
        <nav aria-label="Documentation" className="border-t border-rule px-3 py-2">
          {DOCS_NAV.map((section) => (
            <div key={section.label} className="py-2">
              <Eyebrow>{section.label}</Eyebrow>
              <ul>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      data-ui="nav-item"
                      className="flex min-h-11 items-center px-3 text-sm"
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
