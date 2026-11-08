import { DOCS_AREAS } from "./doc-sections"
import { navFor } from "./nav"

/** Complete ordinary-link fallback for both audiences without client routing. */
export function DocsNoScriptNav() {
  return (
    <noscript>
      <details data-docs-noscript-nav className="md:hidden mb-6 border border-rule-strong">
        <summary className="flex min-h-11 cursor-pointer items-center px-3">
          Documentation menu
        </summary>
        {DOCS_AREAS.map((area) => (
          <nav
            key={area.id}
            aria-label={`${area.label} documentation`}
            className="border-t border-rule px-3 py-2"
          >
            <a href={area.href} className="font-semibold">
              {area.label}
            </a>
            {navFor(area.id).map((section) => (
              <div key={section.label} className="py-2">
                <p className="text-sm font-semibold">{section.label}</p>
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
        ))}
      </details>
    </noscript>
  )
}
