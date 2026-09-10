/**
 * The B4.run error-code registry.
 *
 * A single, frozen source of truth mapping a stable numeric code
 * (`B4_Exxxx`) to a short human-readable `title` and an optional `docsPath`.
 * Producers across every package import codes from here so a failure becomes
 * linkable, searchable, and self-documenting on all three surfaces (CLI
 * stderr, HTTP/SSE bodies, and tool-result strings).
 *
 * Numeric ranges by category:
 *   E1xxx  config / `b4 check`
 *   E2xxx  sandbox
 *   E3xxx  permissions
 *   E4xxx  model / provider
 *   E5xxx  runtime / import
 */

export interface B4ErrorDescriptor {
  /** Stable machine-readable identifier, e.g. `B4_E2001`. */
  readonly code: `B4_E${number}`
  /** Stable, short, human-readable English title. */
  readonly title: string
  /** `/docs/<slug>#<anchor>` convention; optional (a code without docs is valid). */
  readonly docsPath?: string
}

/** Canonical docs base for rendered error links. */
const DOCS_BASE = "https://b4.run"

export const B4_ERRORS = {
  B4_E1001: {
    code: "B4_E1001",
    title: "Invalid tool scope",
    docsPath: "/docs/tools#scoping-a-routes-tools",
  },
  B4_E1002: {
    code: "B4_E1002",
    title: "Invalid sandbox config",
    docsPath: "/docs/configuration#sandbox",
  },
  B4_E1003: {
    code: "B4_E1003",
    title: "Unknown build target",
    docsPath: "/docs/deployment",
  },
  B4_E1004: {
    code: "B4_E1004",
    title: "Invalid delegation policy",
    docsPath: "/docs/subagents#delegation-policy",
  },
  B4_E1005: {
    code: "B4_E1005",
    title: "Feature unsupported by the build target or runtime",
    docsPath: "/docs/deployment",
  },
  B4_E2001: {
    code: "B4_E2001",
    title: "Sandbox unavailable",
    docsPath: "/docs/sandbox#what-it-is--and-isnt",
  },
  B4_E2002: {
    code: "B4_E2002",
    title: "Sandbox preflight failed",
    docsPath: "/docs/sandbox#quickstart",
  },
  B4_E3001: {
    code: "B4_E3001",
    title: "Permission denied",
    docsPath: "/docs/permissions",
  },
  B4_E3002: {
    code: "B4_E3002",
    title: "Subagent dispatch denied",
    docsPath: "/docs/subagents#delegation-policy",
  },
  B4_E3003: {
    code: "B4_E3003",
    title: "Thread access policy failed to load",
    docsPath: "/docs/thread-access#load-failures",
  },
  B4_E3004: {
    code: "B4_E3004",
    title: "Middleware failed to load",
    docsPath: "/docs/middleware#when-middleware-fails-to-load",
  },
  B4_E4001: {
    code: "B4_E4001",
    title: "Model provider package missing",
    docsPath: "/docs/configuration",
  },
  B4_E4002: {
    code: "B4_E4002",
    title: "Unknown model id",
    docsPath: "/docs/configuration",
  },
  B4_E5001: {
    code: "B4_E5001",
    title: "Import or export mismatch",
  },
  B4_E5002: {
    code: "B4_E5002",
    title: "Tool file has the wrong shape",
    docsPath: "/docs/tools",
  },
  B4_E5003: {
    code: "B4_E5003",
    title: "Subagent unavailable or dispatch failed",
    docsPath: "/docs/subagents#dispatch-failures",
  },
  B4_E5101: {
    code: "B4_E5101",
    title: "Node version below the supported floor",
  },
  B4_E5201: {
    code: "B4_E5201",
    title: "Inspector server failed",
    docsPath: "/docs/inspector",
  },
  B4_E5301: {
    code: "B4_E5301",
    title: "Runtime store not provided",
    docsPath: "/docs/deployment",
  },
} as const satisfies Record<string, B4ErrorDescriptor>

/** The union of all registered error codes. Producers cannot invent codes. */
export type B4ErrorCode = keyof typeof B4_ERRORS

/** Look up the descriptor for a registered code. */
export function describeError(code: B4ErrorCode): B4ErrorDescriptor {
  return B4_ERRORS[code]
}

/**
 * The canonical docs URL for a code, or `undefined` when the code has no
 * `docsPath` (still a valid, searchable code).
 */
export function errorDocsUrl(code: B4ErrorCode, base = DOCS_BASE): string | undefined {
  const path = describeError(code).docsPath
  return path ? `${base}${path}` : undefined
}
