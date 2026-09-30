import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const css = (path: string) => readFileSync(resolve(__dirname, path), "utf8")
const rule = (source: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? ""
}

// WCAG 1.4.1: a link inside text can't differ by colour alone, and homepage
// links inherit the text colour. They get the docs' underline: olive on paper.
it("underlines every homepage link, olive on paper, like the docs", () => {
  const home = rule(css("homepage.module.css"), ".home a")
  expect(home).toMatch(/color:\s*inherit/)
  expect(home).toMatch(/text-decoration-line:\s*underline/)
  expect(home).toMatch(/text-decoration-color:\s*var\(--color-olive\)/)
  expect(home).toMatch(/text-decoration-thickness:\s*1px/)
  expect(rule(css("homepage.module.css"), ".home a:hover")).toMatch(
    /text-decoration-thickness:\s*2px/,
  )
})

// `.home a` is (0,1,1) and lives in another module, so load order can't decide:
// every override needs more specificity.
it("switches to the panel accent on dark panels", () => {
  for (const [file, selector] of [
    ["homepage.module.css", ".takeaway a[href]"],
    ["homepage.module.css", ".codeHeading a[href]"],
    ["gates/gates.module.css", ".panel a[href]"],
    ["shapes/shapes.module.css", ".panel a[href]"],
    ["ship/ship.module.css", ".panel a[href]"],
  ] as const) {
    expect(rule(css(file), selector), `${file} ${selector}`).toMatch(
      /text-decoration-color:\s*var\(--color-panel-accent\)/,
    )
  }
})

it("leaves link-shaped controls without the underline", () => {
  expect(rule(css("tour/tour.module.css"), ".chips .chip")).toMatch(/text-decoration:\s*none/)
  expect(rule(css("scaffold-terminal.module.css"), ".agent[href]")).toMatch(
    /text-decoration:\s*none/,
  )
})
