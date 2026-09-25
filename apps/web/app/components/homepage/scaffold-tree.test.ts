import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { layoutTree, type ScaffoldEntry, scaffoldTree } from "./scaffold-tree"

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const templateRoot = resolve(repoRoot, "packages/devkit/templates/app-basic")
const cli = readFileSync(resolve(repoRoot, "packages/create-b4-app/src/index.ts"), "utf8")
const appName = scaffoldTree.command.split(" ").at(-1)

const flatten = (entries: readonly ScaffoldEntry[]): ScaffoldEntry[] =>
  entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])])

describe("the hero terminal shows what the scaffold really creates", () => {
  it("lists only files the basic template ships", () => {
    for (const { path } of flatten(scaffoldTree.entries)) {
      const shipped =
        existsSync(resolve(templateRoot, path)) ||
        existsSync(resolve(templateRoot, `${path}.template`))
      expect(shipped, path).toBe(true)
    }
  })

  it("labels each entry with the end of its own path", () => {
    for (const { path, label } of flatten(scaffoldTree.entries)) {
      expect(path.endsWith(label.replace(/\/$/, "")), `${label} vs ${path}`).toBe(true)
    }
  })

  it("prints the line create-b4-app prints, for its default template", () => {
    expect(scaffoldTree.command).toBe("npm create b4-app@latest my-agent")
    expect(cli).toContain('let template = "basic"')
    // Regex, not a string: Biome's noTemplateCurlyInString rejects "${…}" in plain strings.
    expect(cli).toMatch(/`✔ Created \$\{appName\} \(\$\{options\.template\} template\)`/)
    expect(scaffoldTree.created).toBe(`Created ${appName} (basic template)`)
    expect(scaffoldTree.root).toBe(`${appName}/`)
  })

  it("ends on the next steps create-b4-app prints for the basic template", () => {
    expect(cli).toMatch(/ {2}cd \$\{targetDir\}/)
    expect(cli).toContain('"  npm install"')
    expect(cli).toMatch(/" {2}npm test\s+# offline tests/)
    expect(scaffoldTree.next).toBe(`cd ${appName} && npm install && npm test`)
  })

  it("links exactly one entry, the agent folder, to the first-agent section", () => {
    const linked = flatten(scaffoldTree.entries).filter((entry) => entry.href !== undefined)
    expect(linked.map((entry) => [entry.path, entry.href])).toEqual([
      ["src/app/hello", "#first-agent"],
    ])
  })
})

describe("layoutTree", () => {
  it("draws box glyphs and numbers rows in reading order after the lines above", () => {
    const { rows, next } = layoutTree(scaffoldTree.entries, 3)
    expect(rows.map((row) => row.glyph)).toEqual(["├─ ", "├─ ", "├─ ", "└─ "])
    const hello = rows[2]
    expect(hello?.label).toBe("src/app/hello/")
    expect(hello?.children.map((row) => row.glyph)).toEqual(["│  ├─ ", "│  ├─ ", "│  └─ "])
    const orders = rows.flatMap((row) => [row.order, ...row.children.map((child) => child.order)])
    expect(orders).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(next).toBe(10)
  })

  it("indents under a last entry with spaces, not a rule", () => {
    const { rows } = layoutTree(
      [{ label: "a/", path: "a", note: "", children: [{ label: "b", path: "a/b", note: "" }] }],
      0,
    )
    expect(rows[0]?.children[0]?.glyph).toBe("   └─ ")
  })
})
