import { API_REFERENCE_PAGES } from "./api-reference-pages"

export interface DocsNavItem {
  readonly label: string
  readonly href: string
}

export interface DocsNavSection {
  readonly label: string
  readonly items: readonly DocsNavItem[]
}

export const DOCS_NAV = [
  {
    label: "Get Started",
    items: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Mental Model", href: "/docs/mental-model" },
      { label: "Migrating from LangGraph", href: "/docs/migrating-from-langgraph" },
    ],
  },
  {
    label: "Build",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Workspace Filesystem", href: "/docs/workspace" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "Dev Server", href: "/docs/dev-server" },
    ],
  },
  {
    label: "Agent Capabilities",
    items: [
      { label: "Planning", href: "/docs/planning" },
      { label: "Skills", href: "/docs/skills" },
      { label: "Subagents", href: "/docs/subagents" },
      { label: "Context Management", href: "/docs/context-management" },
      { label: "Reasoning Effort", href: "/docs/reasoning-effort" },
      { label: "Retry", href: "/docs/retry" },
    ],
  },
  {
    label: "Memory",
    items: [
      { label: "Memory", href: "/docs/memory" },
      { label: "Long-term Memory", href: "/docs/memory/long-term" },
      { label: "Recall and Retrieval", href: "/docs/memory/retrieval" },
      { label: "Episodes", href: "/docs/memory/episodes" },
      { label: "Distillation", href: "/docs/memory/distillation" },
      { label: "Browse and Manage Memory", href: "/docs/memory/browse" },
    ],
  },
  {
    label: "Connect Clients",
    items: [
      { label: "Agent Protocol", href: "/docs/dev-server/agent-protocol" },
      { label: "AG-UI and Web Clients", href: "/docs/ag-ui" },
      { label: "Embed the Runtime", href: "/docs/embedding" },
    ],
  },
  {
    label: "Test and Evaluate",
    items: [
      { label: "Scenario Testing", href: "/docs/testing" },
      { label: "Agent Test Harness", href: "/docs/testing-agents" },
      { label: "Fixtures and Recording", href: "/docs/testing-agents/fixtures" },
      { label: "Evals", href: "/docs/evals" },
    ],
  },
  {
    label: "Secure",
    items: [
      { label: "Security Architecture", href: "/docs/security-architecture" },
      { label: "Thread Access", href: "/docs/thread-access" },
      { label: "Access Control", href: "/docs/access-control" },
      { label: "Permissions", href: "/docs/permissions" },
      { label: "Execution Sandbox", href: "/docs/sandbox" },
      { label: "Kubernetes Sandbox", href: "/docs/sandbox/kubernetes" },
    ],
  },
  {
    label: "Deploy",
    items: [
      { label: "Deployment Options", href: "/docs/deployment" },
      { label: "Node and Docker", href: "/docs/deployment/node" },
      { label: "Kubernetes", href: "/docs/deployment/kubernetes" },
      { label: "Vercel", href: "/docs/deployment/vercel" },
      { label: "Edge and Hono", href: "/docs/deployment/edge" },
      { label: "LangSmith", href: "/docs/deployment/langsmith" },
    ],
  },
  {
    label: "Operate",
    items: [
      { label: "Persistence and Tenancy", href: "/docs/persistence" },
      { label: "Production Topology", href: "/docs/production-topology" },
      { label: "Observability", href: "/docs/observability" },
      { label: "Inspector", href: "/docs/inspector" },
      { label: "Upgrading", href: "/docs/upgrading" },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Recipes Overview", href: "/docs/recipes" },
      { label: "Add a Tool", href: "/docs/recipes/add-a-tool" },
      { label: "Typed State", href: "/docs/recipes/typed-state" },
      { label: "Auth Middleware", href: "/docs/recipes/auth-middleware" },
      { label: "Stream Output", href: "/docs/recipes/stream-output" },
      { label: "Retry Transient Model Calls", href: "/docs/recipes/retry-flaky-tools" },
      { label: "Dispatch from a Route", href: "/docs/recipes/dispatch-from-route" },
      { label: "Research Assistant Web UI", href: "/docs/recipes/research-web-ui" },
      { label: "Blueprints", href: "/docs/blueprints" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Configuration Reference", href: "/docs/configuration" },
      { label: "CLI Reference", href: "/docs/cli" },
      { label: "API Reference", href: "/docs/api" },
      { label: "Error Codes", href: "/docs/errors" },
      { label: "FAQ", href: "/docs/faq" },
    ],
  },
] as const

// Flat ordered list of pages — used for prev/next navigation.
type JourneyDocsPage = (typeof DOCS_NAV)[number]["items"][number]
type ApiDocsPage = (typeof API_REFERENCE_PAGES)[number]

export const DOCS_PAGES: readonly JourneyDocsPage[] = DOCS_NAV.flatMap(
  (section) => section.items as readonly JourneyDocsPage[],
)

export const ALL_DOCS_PAGES: readonly (JourneyDocsPage | ApiDocsPage)[] = DOCS_PAGES.flatMap(
  (page): readonly (JourneyDocsPage | ApiDocsPage)[] =>
    page.href === "/docs/api" ? [page, ...API_REFERENCE_PAGES] : [page],
)

export type DocsPageHref = (typeof ALL_DOCS_PAGES)[number]["href"]

export interface DocsCrumb {
  readonly label: string
  readonly href?: string
}

const DOCS_HOME = "/docs/getting-started"

// Build breadcrumbs for a given href: Docs / <nav section> / <page>. The
// section is a label, not a route, so it is left unlinked; every other
// ancestor links to a real route and the current page is the final, unlinked
// crumb. Docs links to the first page, so on that page Docs is unlinked too
// rather than linking to itself.
export function breadcrumbsFor(href: string): readonly DocsCrumb[] {
  const DOCS_CRUMB: DocsCrumb =
    href === DOCS_HOME ? { label: "Docs" } : { label: "Docs", href: DOCS_HOME }
  const referencePage = API_REFERENCE_PAGES.find((page) => page.href === href)
  if (referencePage) {
    const hub = sectionFor(referencePage.parent.href)
    return [
      DOCS_CRUMB,
      ...(hub ? [{ label: hub.label }] : []),
      { label: referencePage.parent.label, href: referencePage.parent.href },
      { label: referencePage.label },
    ]
  }

  const page = DOCS_PAGES.find((item) => item.href === href)
  const section = sectionFor(href)
  return [
    DOCS_CRUMB,
    ...(section ? [{ label: section.label }] : []),
    ...(page ? [{ label: page.label }] : []),
  ]
}

function sectionFor(href: string): DocsNavSection | undefined {
  return DOCS_NAV.find((section) => section.items.some((item) => item.href === href))
}

export function siblingsFor(href: string): {
  readonly prev: DocsNavItem | null
  readonly next: DocsNavItem | null
} {
  const idx = DOCS_PAGES.findIndex((p) => p.href === href)
  if (idx < 0) return { prev: null, next: null }
  return {
    prev: idx > 0 ? (DOCS_PAGES[idx - 1] ?? null) : null,
    next: idx < DOCS_PAGES.length - 1 ? (DOCS_PAGES[idx + 1] ?? null) : null,
  }
}
