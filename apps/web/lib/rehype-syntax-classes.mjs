/**
 * Runs after rehype-pretty-code and swaps each Shiki token's inline style for
 * the classes in `options.classes` (built by lib/shiki-classes.ts, whose
 * generated stylesheet is app/styles/syntax.css). A token whose style has any
 * declaration without a class keeps its inline style, so output never changes
 * appearance. Plain JS because @next/mdx imports plugins natively by path.
 *
 * @param {{ classes: Record<string, string> }} options
 */
export default function rehypeSyntaxClasses({ classes }) {
  /** @param {string} style */
  function classesFor(style) {
    const names = []
    for (const declaration of style.split(";")) {
      const key = declaration.replaceAll(/\s+/g, "").toLowerCase()
      if (!key) continue
      const name = classes[key]
      if (!name) return undefined
      names.push(name)
    }
    return names
  }

  /**
   * @param {any} node
   * @param {boolean} inCode
   */
  function visit(node, inCode) {
    const properties = node.type === "element" ? node.properties : undefined
    // rehype-pretty-code marks every block and inline highlight with data-language
    // (Shiki's hast keeps raw attribute names, so check both spellings).
    const code =
      inCode ||
      (properties !== undefined &&
        (properties["data-language"] !== undefined || properties.dataLanguage !== undefined))
    if (code && node.tagName === "span" && typeof properties?.style === "string") {
      const names = classesFor(properties.style)
      if (names?.length) {
        delete properties.style
        const existing = [properties.className, properties.class]
          .flatMap((value) => (Array.isArray(value) ? value : String(value ?? "").split(/\s+/)))
          .filter(Boolean)
        delete properties.class
        properties.className = [...existing, ...names]
      }
    }
    for (const child of node.children ?? []) visit(child, code)
  }

  return (/** @type {any} */ tree) => visit(tree, false)
}
