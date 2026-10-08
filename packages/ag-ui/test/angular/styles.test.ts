import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

/**
 * The Angular templates against the one stylesheet (`src/styles.css`, shipped
 * as `@b4run/ag-ui/styles.css`): every class the kit emits has a rule, and
 * every `.b4-` class in the sheet is emitted. `test/react/styles.test.ts`
 * holds the React kit to the same sheet.
 */
const CSS = readFileSync(`${import.meta.dirname}/../../src/styles.css`, "utf8")
const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

/** The kit and its connectors (`./angular/events`, `./angular/copilotkit`): every template the package ships. */
const DIRS = ["lib", "events", "copilotkit"].map(
  (dir) => `${import.meta.dirname}/../../src/angular/${dir}`,
)
const SOURCES = DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(`${dir}/${file}`, "utf8")),
).join("\n")

/** Static `class="…"` in templates and `class: "…"` in host metadata. */
const emittedClasses = [
  ...new Set(
    [...SOURCES.matchAll(/\bclass(?:=|: )"([^"]+)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)),
  ),
].filter(Boolean)

describe("Angular templates ↔ the shared stylesheet", () => {
  test("the templates emit the contract's classes (the extraction found them)", () => {
    for (const cls of ["b4-turn", "b4-step", "b4-chevron", "b4-approval", "b4-checklist"]) {
      expect(emittedClasses).toContain(cls)
    }
  })

  test("every class the Angular kit emits has at least one rule", () => {
    for (const cls of emittedClasses) expect(withoutComments, cls).toContain(`.${cls}`)
  })

  test("every .b4- class in the sheet is emitted by the Angular kit", () => {
    const sheetClasses = new Set(
      [...withoutComments.matchAll(/\.(b4-[\w-]+)/g)].map((m) => m[1] ?? ""),
    )
    for (const cls of sheetClasses) expect(emittedClasses, cls).toContain(cls)
  })

  test("./styles.css ships the one sheet unchanged", () => {
    const pkg = JSON.parse(readFileSync(`${import.meta.dirname}/../../package.json`, "utf8")) as {
      exports: Record<string, unknown>
    }
    expect(pkg.exports["./styles.css"]).toBe("./dist/styles.css")
    expect(pkg.exports).not.toHaveProperty("./react/styles.css")
    const shipped = readFileSync(`${import.meta.dirname}/../../dist/styles.css`, "utf8")
    expect(shipped).toBe(CSS)
  })

  test("every element host is display: contents, so the contract DOM is what the sheet styles", () => {
    const elementComponents = [
      ...SOURCES.matchAll(/selector: "(b4-[\w-]+)"[\s\S]*?host: \{([^}]*)\}/g),
    ]
    expect(elementComponents.length).toBeGreaterThanOrEqual(7)
    for (const [, selector, host] of elementComponents) {
      expect(host, selector).toContain('style: "display: contents"')
    }
  })
})
