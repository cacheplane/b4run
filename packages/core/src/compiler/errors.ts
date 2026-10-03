export interface UnresolvedImport {
  /** The module specifier or member the compiler could not resolve. */
  readonly specifier: string
  /** The TypeScript diagnostic text, for the operator's eyes. */
  readonly message: string
}

export interface UnresolvedToolInputTypeDetails {
  readonly toolName: string
  readonly fileName: string
  /** The input type annotation as the author wrote it, e.g. `RenderInput`. */
  readonly typeText: string
  /** What the checker turned the annotation into, e.g. `any`. */
  readonly resolvedAs: string
  readonly unresolvedImports: readonly UnresolvedImport[]
  /** The tsconfig the tool program was built with, or `undefined` when none was found. */
  readonly tsconfigPath: string | undefined
  /** Where the tsconfig search started when no config was found. */
  readonly searchedFrom: string | undefined
}

/**
 * A tool declares an input type, but the compiler could not resolve it into an
 * object shape — typically an import through a `tsconfig` `paths` alias the
 * tool program does not know about. Without this the schema silently derives
 * to `{ properties: {} }` and the model is told the tool takes no arguments.
 */
export class UnresolvedToolInputTypeError extends Error {
  readonly details: UnresolvedToolInputTypeDetails

  constructor(details: UnresolvedToolInputTypeDetails) {
    super(formatUnresolvedToolInputType(details))
    this.name = "UnresolvedToolInputTypeError"
    this.details = details
  }
}

function formatUnresolvedToolInputType(details: UnresolvedToolInputTypeDetails): string {
  const lines = [
    `Tool "${details.toolName}" (${details.fileName}): the declared input type \`${details.typeText}\` resolved to ${details.resolvedAs}, so no tool schema can be derived from it.`,
  ]

  for (const unresolved of details.unresolvedImports) {
    lines.push(`  - ${unresolved.specifier}: ${unresolved.message}`)
  }

  lines.push(
    details.tsconfigPath !== undefined
      ? `The tool program used ${details.tsconfigPath}; check that its "paths" / "baseUrl" (including any "extends" chain) cover this import, or pass an explicit \`tsconfig\` to the extractor.`
      : `No tsconfig.json was found${details.searchedFrom !== undefined ? ` above ${details.searchedFrom}` : ""}, so the tool program used B4.run's default compiler options, which have no path aliases. Add a tsconfig.json declaring the alias, or pass an explicit \`tsconfig\` to the extractor.`,
  )
  lines.push("A tool that genuinely takes no input can omit the parameter or declare it as `{}`.")

  return lines.join("\n")
}
