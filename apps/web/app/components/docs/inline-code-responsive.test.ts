import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../styles/prose.css"),
  "utf8",
)

describe("responsive inline code", () => {
  it("never forces inline code onto one line", () => {
    const baseRule = /^\.mdx-inline-code\s*{([^}]*)}/m.exec(CSS)?.[1]

    expect(baseRule).toBeDefined()
    expect(baseRule).not.toMatch(/white-space:\s*nowrap/)
  })

  it("wraps inline code below 48rem while preserving block-code behavior", () => {
    // prose.css has several 47.999rem media blocks; take the one about inline code.
    const mediaRule = [...CSS.matchAll(/@media\s*\(max-width:\s*47\.999rem\)\s*{([\s\S]*?)\n}/g)]
      .map((m) => m[1])
      .find((body) => body?.trimStart().startsWith(".mdx-inline-code"))

    expect(mediaRule).toMatch(
      /\.mdx-inline-code\s*{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    )
    expect(mediaRule).toMatch(
      /pre \.mdx-inline-code\s*{[^}]*white-space:\s*inherit;[^}]*overflow-wrap:\s*normal;/s,
    )
  })
})
