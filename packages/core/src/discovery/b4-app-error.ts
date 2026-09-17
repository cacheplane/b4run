import type { B4ErrorCode } from "@b4run/sdk"

/**
 * A failure in the B4.run app ON DISK — the app root, its package.json, or a
 * route entry — that carries a registry code so the CLI can render the
 * `[B4_Exxxx] See <docs>` footer. Discovery throws plain `Error`s for the
 * cases with no registry entry; this class is for the ones that have one.
 */
export class B4AppError extends Error {
  readonly code: B4ErrorCode

  constructor(message: string, code: B4ErrorCode, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "B4AppError"
    this.code = code
  }
}
