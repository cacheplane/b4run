import { z } from "zod"
import type { JsonSchemaProperty } from "./types.js"

const MAX_ZOD_DEPTH = 8

export function jsonSchemaToZod(schema: JsonSchemaProperty): z.ZodObject<z.ZodRawShape> {
  return objectToZod(schema, 0) as z.ZodObject<z.ZodRawShape>
}

function objectToZod(prop: JsonSchemaProperty, depth: number): z.ZodTypeAny {
  // Record<string,T>: schema-valued additionalProperties and no named properties.
  if (
    typeof prop.additionalProperties === "object" &&
    prop.additionalProperties !== null &&
    (!prop.properties || Object.keys(prop.properties).length === 0)
  ) {
    return z.record(z.string(), jsonSchemaFieldToZod(prop.additionalProperties, depth + 1))
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(prop.required ?? [])
  for (const [key, sub] of Object.entries(prop.properties ?? {})) {
    let field = jsonSchemaFieldToZod(sub, depth + 1)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return z.object(shape)
}

function jsonSchemaFieldToZod(prop: JsonSchemaProperty, depth = 0): z.ZodTypeAny {
  if (depth > MAX_ZOD_DEPTH) return z.string()

  // Object unions are emitted as anyOf (no `type`); map to z.union.
  if (prop.anyOf && prop.anyOf.length > 0) {
    const members = prop.anyOf.map((m) => jsonSchemaFieldToZod(m, depth + 1))
    if (members.length === 1) return members[0] ?? z.unknown()
    return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  switch (prop.type) {
    case "string":
      return prop.enum && prop.enum.length > 0
        ? z.enum([...prop.enum] as [string, ...string[]])
        : z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array": {
      const items = prop.items
      return items ? z.array(jsonSchemaFieldToZod(items, depth + 1)) : z.array(z.unknown())
    }
    case "object":
      return objectToZod(prop, depth)
    default:
      return z.unknown()
  }
}

