export interface DisplayCode {
  readonly raw: string
  readonly lines: readonly string[]
  readonly path: string
  readonly url: string
  readonly firstLine: number
  readonly fold?: { readonly start: number; readonly end: number }
  readonly wrap?: boolean
  readonly linkLabel?: string
  /** Accessible region name when `path` alone would repeat another panel's. */
  readonly label?: string
}
