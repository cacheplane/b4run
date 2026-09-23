/**
 * Old `/docs/<page>#<fragment>` links that must keep landing after a section
 * moved to its own page.
 *
 * - `redirect`: the old page keeps only an invisible element with the old id,
 *   and `LegacyAnchorRedirect` forwards the reader to `canonicalHref`.
 * - `section`: the old page still has a short, real section with the old id
 *   that links to `canonicalHref`.
 *
 * `docs-anchors.test.ts` and `scripts/check-docs.mjs` both read this list.
 */
export type LegacyAnchorMode = "redirect" | "section"

export interface LegacyAnchor {
  /** The old page's MDX file, relative to `content/docs`. */
  readonly legacyFile: string
  /** The old link, `/docs/<page>#<fragment>`. */
  readonly legacyHref: string
  /** Where the content lives now. It may carry its own fragment. */
  readonly canonicalHref: string
  readonly mode: LegacyAnchorMode
}

function anchors(
  legacyFile: string,
  legacyPath: string,
  mode: LegacyAnchorMode,
  targets: Readonly<Record<string, string>>,
): LegacyAnchor[] {
  return Object.entries(targets).map(([fragment, canonicalHref]) => ({
    legacyFile,
    legacyHref: `${legacyPath}#${fragment}`,
    canonicalHref,
    mode,
  }))
}

export const LEGACY_ANCHORS: readonly LegacyAnchor[] = [
  ...anchors("memory.mdx", "/docs/memory", "redirect", {
    "long-term-collection-memoryts": "/docs/memory/long-term",
    "generated-tools": "/docs/memory/long-term#generated-recall-and-remember-tools",
    "write-governance": "/docs/memory/long-term#write-governance",
    "ask-mode": "/docs/memory/long-term#ask-mode",
    "reviewing-candidates": "/docs/memory/long-term#reviewing-candidates",
    configuration: "/docs/memory/long-term#configuration",
    testing: "/docs/memory/long-term#testing",
    "verifying-against-a-real-model": "/docs/memory/long-term#verifying-against-a-real-model",
    "whats-deferred": "/docs/memory/long-term#whats-deferred",
    "how-recall-ranks": "/docs/memory/retrieval#how-recall-ranks",
    "semantic-recall-opt-in": "/docs/memory/retrieval#semantic-recall-opt-in",
    "postgres-backend-pgvector": "/docs/memory/retrieval#postgres-backend-pgvector",
    "the-injected-index": "/docs/memory/retrieval#the-injected-index",
    "episodic-memory": "/docs/memory/episodes",
    "enabling-the-run-recorder": "/docs/memory/episodes#enabling-the-run-recorder",
    "what-gets-recorded": "/docs/memory/episodes#what-gets-recorded",
    retention: "/docs/memory/episodes#retention",
    "time-windowed-recall": "/docs/memory/episodes#time-windowed-recall",
    governance: "/docs/memory/episodes#governance",
    "agent-authored-episodes": "/docs/memory/episodes#agent-authored-episodes",
    distillation: "/docs/memory/distillation",
    consolidation: "/docs/memory/distillation#consolidation",
    reflection: "/docs/memory/distillation#reflection",
    "distilled-records-are-found-by-keyword":
      "/docs/memory/distillation#distilled-records-are-found-by-keyword",
    provenance: "/docs/memory/distillation#provenance",
    cost: "/docs/memory/distillation#cost",
    "running-it-on-a-schedule": "/docs/memory/distillation#running-it-on-a-schedule",
    "distillation-configuration": "/docs/memory/distillation#distillation-configuration",
  }),
  ...anchors("memory.mdx", "/docs/memory", "section", {
    "updating-it": "/docs/workspace",
  }),
  ...anchors("deployment.mdx", "/docs/deployment", "redirect", {
    "deploying-to-production-nodedocker": "/docs/deployment/node",
    "deploying-on-kubernetes": "/docs/deployment/kubernetes",
    "the-langsmith--langgraph-platform-path": "/docs/deployment/langsmith",
    "edge-runtimes": "/docs/deployment/edge",
    "the-b4runclifetch-entry-point": "/docs/deployment/edge#compose-through-b4runclifetch",
    "the-hono-build-target": "/docs/deployment/edge#select-hono",
    "why-the-stores-are-per-request": "/docs/deployment/edge#why-the-stores-are-per-request",
    "what-the-edge-cannot-serve": "/docs/deployment/edge#what-the-edge-cannot-serve",
    "what-is-proven-and-what-is-not": "/docs/deployment/edge#what-is-proven-and-what-is-not",
  }),
  ...anchors("deployment.mdx", "/docs/deployment", "section", {
    "what-b4run-does-not-do": "/docs/deployment",
    troubleshooting: "/docs/deployment",
    related: "/docs/deployment",
    "self-hosting": "/docs/deployment/node",
  }),
  ...anchors("sandbox.mdx", "/docs/sandbox", "section", {
    "kubernetes-provider": "/docs/sandbox/kubernetes",
  }),
  ...anchors("sandbox.mdx", "/docs/sandbox", "redirect", {
    "security-hardening-on-kubernetes": "/docs/sandbox/kubernetes",
    "network-policy-on-kubernetes": "/docs/sandbox/kubernetes#networkpolicy-and-dns",
    "deploying-the-sandbox-infrastructure-helm":
      "/docs/sandbox/kubernetes#install-the-sandbox-infrastructure",
    "key-caveats": "/docs/sandbox/kubernetes",
    "deploying-a-b4run-app-helm": "/docs/deployment/kubernetes",
    "serviceaccount-and-namespace-wiring": "/docs/sandbox/kubernetes#wire-application-rbac",
    "env-secrets-and-replicas": "/docs/deployment/kubernetes",
  }),
  ...anchors("dev-server.mdx", "/docs/dev-server", "redirect", {
    "agent-protocol-endpoints": "/docs/dev-server/agent-protocol#agent-protocol-endpoints",
    "sse-event-types": "/docs/dev-server/agent-protocol#streaming-over-sse",
    "thread-lifecycle-with-curl": "/docs/dev-server/agent-protocol#thread-lifecycle-with-curl",
    "one-run-at-a-time-per-thread": "/docs/dev-server/agent-protocol#one-run-at-a-time-per-thread",
    "client-disconnect": "/docs/dev-server/agent-protocol#client-disconnect",
  }),
  ...anchors("dev-server.mdx", "/docs/dev-server", "section", {
    "ag-ui-endpoint": "/docs/ag-ui",
    tracing: "/docs/observability",
    middleware: "/docs/middleware",
  }),
  ...anchors("testing-agents.mdx", "/docs/testing-agents", "redirect", {
    "fixture-files-author-commit-replay":
      "/docs/testing-agents/fixtures#fixture-files-author-commit-replay",
    "author-inline-and-snapshot-to-a-file":
      "/docs/testing-agents/fixtures#author-inline-and-snapshot-to-a-file",
    "record-from-a-real-model-local-only":
      "/docs/testing-agents/fixtures#record-from-a-real-model-local-only",
    "replay-a-fixture-file-in-tests":
      "/docs/testing-agents/fixtures#replay-a-fixture-file-in-tests",
    "live-mode-real-model": "/docs/testing-agents/fixtures#live-mode-real-model",
  }),
]

export interface LegacyRedirect {
  /** The old fragment, without `#`. */
  readonly id: string
  readonly canonicalHref: string
}

/** The redirecting legacy fragments a docs page must carry, in map order. */
export function legacyRedirectsFor(href: string): LegacyRedirect[] {
  return LEGACY_ANCHORS.flatMap((anchor) => {
    const [path, id] = anchor.legacyHref.split("#")
    return anchor.mode === "redirect" && path === href && id
      ? [{ id, canonicalHref: anchor.canonicalHref }]
      : []
  })
}

/** Maps a `location.hash` to its new home, or `undefined` when it is not a legacy fragment. */
export function resolveLegacyHash(
  hash: string,
  redirects: readonly LegacyRedirect[],
): string | undefined {
  let id = hash.startsWith("#") ? hash.slice(1) : hash
  try {
    id = decodeURIComponent(id)
  } catch {
    return undefined
  }
  return redirects.find((redirect) => redirect.id === id)?.canonicalHref
}
