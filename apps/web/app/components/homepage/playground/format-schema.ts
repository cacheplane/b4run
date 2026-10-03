type Scalar = null | boolean | number | string

const isScalar = (value: unknown): value is Scalar =>
  value === null || ["boolean", "number", "string"].includes(typeof value)
const isFlat = (value: unknown): boolean =>
  isScalar(value) || (Array.isArray(value) && value.every(isScalar))

function inline(value: unknown): string {
  if (isScalar(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    return `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`).join(", ")} }`
  }
  throw new TypeError(`Not a JSON value: ${typeof value}`)
}

/**
 * Prints a JSON value the way the playground shows it: two-space indents, with
 * arrays of scalars, and objects of scalars that fit in `width`, kept on one
 * line. The values are the extractor's; only the layout is ours, so the schema
 * fits the panel.
 */
export function formatSchema(value: unknown, width = 64): string[] {
  const print = (node: unknown, indent: string, prefix: string, suffix: string): string[] => {
    const oneLine = `${indent}${prefix}${inline(node)}${suffix}`
    const flatObject =
      typeof node === "object" &&
      node !== null &&
      !Array.isArray(node) &&
      Object.values(node).every(isFlat)
    if (isFlat(node) || (flatObject && oneLine.length <= width)) return [oneLine]
    const inner = `${indent}  `
    if (Array.isArray(node)) {
      return [
        `${indent}${prefix}[`,
        ...node.flatMap((item, index) =>
          print(item, inner, "", index < node.length - 1 ? "," : ""),
        ),
        `${indent}]${suffix}`,
      ]
    }
    const entries = Object.entries(node as Record<string, unknown>)
    return [
      `${indent}${prefix}{`,
      ...entries.flatMap(([key, entry], index) =>
        print(entry, inner, `${JSON.stringify(key)}: `, index < entries.length - 1 ? "," : ""),
      ),
      `${indent}}${suffix}`,
    ]
  }
  return print(value, "", "", "")
}
