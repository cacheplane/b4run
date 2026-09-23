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
export interface WalkthroughProps {
  readonly files: Readonly<Record<"agent" | "config" | "plan", DisplayCode>>
  readonly patch: DisplayCode
  readonly command: string
  readonly failure: string
  readonly visible: readonly string[]
  readonly independent: readonly string[]
}
