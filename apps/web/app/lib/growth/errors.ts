const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/

/** Stores only short machine codes, so nothing a provider echoes back (an address, say) is kept. */
export function safeErrorCode(code: string): string {
  return ERROR_CODE_PATTERN.test(code) ? code : "unclassified"
}

/**
 * A missing or malformed growth setting. The message names the variable for whoever reads the
 * exception; logs carry only `code`.
 */
export class GrowthConfigError extends Error {
  readonly code = "config_invalid"

  constructor(message: string) {
    super(message)
    this.name = "GrowthConfigError"
  }
}

/** A short code for a route's error log: the error's code if it has one, never the message. */
export function errorLogCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" ? safeErrorCode(code.toLowerCase()) : "unclassified"
}
