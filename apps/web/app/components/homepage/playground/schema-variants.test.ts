import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  extractSchemaVariants,
  schemaVariantsFile,
  variantCombinations,
  variantId,
} from "../../../../scripts/export-homepage-demos.mjs"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const recorded = JSON.parse(readFileSync(schemaVariantsFile, "utf8"))

interface RecordedVariant {
  readonly id: string
  readonly formal: boolean
  readonly language: boolean
  readonly jsdoc: boolean
  readonly source: string
  readonly schema: {
    readonly description: string
    readonly parameters: {
      readonly properties: Record<string, unknown>
      readonly required: readonly string[]
    }
  }
}
const variants: readonly RecordedVariant[] = recorded.variants

describe("the type-to-schema playground shows what the framework extracts", () => {
  it("records every combination of the three toggles once", () => {
    expect(variants.map((variant) => variant.id)).toEqual(variantCombinations().map(variantId))
    expect(new Set(variants.map((variant) => variant.id)).size).toBe(8)
  })

  it("starts from the scaffold's own greet tool", () => {
    const template = resolve(
      repoRoot,
      "packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts",
    )
    expect(variants.find((variant) => variant.id === "base")?.source).toBe(
      readFileSync(template, "utf8"),
    )
  })

  it("changes only what each toggle says it changes", () => {
    for (const { id, formal, language, jsdoc, schema } of variants) {
      expect(Object.keys(schema.parameters.properties), id).toEqual([
        "name",
        ...(formal ? ["formal"] : []),
        ...(language ? ["language"] : []),
      ])
      expect(schema.parameters.required, id).toEqual(["name", ...(language ? ["language"] : [])])
      expect(schema.description, id).toBe(jsdoc ? "Greet someone by name." : "")
    }
  })

  it("reproduces schema-variants.json exactly when the extraction runs again", async () => {
    // Compare as text: the panel prints keys in order, so order is part of the pin.
    expect(JSON.stringify(await extractSchemaVariants(), null, 2)).toBe(JSON.stringify(recorded, null, 2))
  }, 60_000)
})
