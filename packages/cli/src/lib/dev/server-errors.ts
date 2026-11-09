import { B4_ERRORS, type B4ErrorCode, errorDocsUrl } from "@b4run/sdk"

export type RuntimeServerErrorKind = "request_error" | "execution_error"

export interface RuntimeServerErrorBody {
  readonly error: {
    readonly kind: RuntimeServerErrorKind
    readonly message: string
    readonly details?: Record<string, unknown>
    readonly code?: B4ErrorCode
    readonly docsUrl?: string
  }
}

interface ErrorBodyOptions {
  readonly code?: B4ErrorCode
}

function buildBody(
  kind: RuntimeServerErrorKind,
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  const code = options?.code
  const docsUrl = code ? errorDocsUrl(code) : undefined
  return {
    error: {
      ...(details ? { details } : {}),
      ...(code ? { code } : {}),
      ...(docsUrl ? { docsUrl } : {}),
      kind,
      message,
    },
  }
}

export function createRequestErrorBody(
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  return buildBody("request_error", message, details, options)
}

export function createExecutionErrorBody(
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  return buildBody("execution_error", message, details, options)
}

/** Read a B4.run error code off a caught error, if it carries a real registry code. */
export function b4ErrorCodeOf(error: unknown): B4ErrorCode | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && code in B4_ERRORS) {
      return code as B4ErrorCode
    }
  }
  return undefined
}

/** Catalog failures have fixed public messages on the standard protocol. Never
 * reflect a denied route, configured default, or arbitrary exception details. */
export function safeProtocolCatalogCode(
  error: unknown,
): "not_found" | "agent_required" | "invalid_argument" | undefined {
  if (!(error instanceof Error) || error.name !== "AgentCatalogError") return undefined
  const code = (error as Error & { readonly code?: unknown }).code
  return code === "not_found" || code === "agent_required" || code === "invalid_argument"
    ? code
    : undefined
}
