/** One recorded greet.ts variant, prepared for the playground island. */
export interface PlaygroundVariant {
  readonly id: string
  readonly formal: boolean
  readonly language: boolean
  readonly jsdoc: boolean
  /** From the extracted schema. */
  readonly required: readonly string[]
  /** From the extracted schema; empty when the tool has no JSDoc. */
  readonly description: string
  /** Highlighted HTML, one entry per source line (highlightCode). */
  readonly sourceLines: readonly string[]
  /** Highlighted HTML, one entry per schema line. */
  readonly schemaLines: readonly string[]
  /** The schema as displayed, one entry per line; the diff compares these. */
  readonly schemaText: readonly string[]
}
