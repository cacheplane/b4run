import { analyzeToolSource } from "./compiler/typescript-backend.js"
import { typeInfoToToolParameters } from "./compiler/json-schema.js"
import { jsonSchemaToZod } from "./validator.js"

export function compileTool(source: string) {
  const tool = analyzeToolSource(source, "/virtual/tool.ts")
  if (!tool) throw new Error("Expected a default-exported tool")
  const schema = typeInfoToToolParameters(tool.parameter)
  return { schema, validator: jsonSchemaToZod(schema) }
}
