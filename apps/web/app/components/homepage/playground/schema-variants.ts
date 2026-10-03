import "server-only"
import { highlightCode } from "../highlight"
import { formatSchema } from "./format-schema"
import data from "./schema-variants.json"
import type { PlaygroundVariant } from "./types"

/** The playground's eight greet.ts variants, highlighted, as export-homepage-demos.mjs recorded them. */
export async function preparePlayground(): Promise<readonly PlaygroundVariant[]> {
  return Promise.all(
    data.variants.map(async (variant) => {
      const schemaText = formatSchema(variant.schema)
      const [source, schema] = await Promise.all([
        highlightCode(variant.source, "typescript", "src/app/hello/tools/greet.ts", ""),
        highlightCode(schemaText.join("\n"), "json", "What the model sees", ""),
      ])
      return {
        id: variant.id,
        formal: variant.formal,
        language: variant.language,
        jsdoc: variant.jsdoc,
        required: variant.schema.parameters.required,
        description: variant.schema.description,
        sourceLines: source.lines,
        schemaLines: schema.lines,
        schemaText,
      }
    }),
  )
}
