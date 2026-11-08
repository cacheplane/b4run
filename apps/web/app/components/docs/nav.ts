import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { type DocsArea, docsArea } from "./doc-sections"

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
      { label: "Reasoning", href: "/docs/reasoning-effort" },
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
      { label: "Testing Overview", href: "/docs/testing-overview" },
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
      { label: "Approval Grants", href: "/docs/approval-grants" },
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
      { label: "Troubleshooting", href: "/docs/troubleshooting" },
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
      { label: "Navlog Example App", href: "/docs/recipes/navlog" },
      { label: "Software Factory Example", href: "/docs/recipes/software-factory" },
      { label: "Build a Flight Planner", href: "/docs/recipes/flight-planner" },
      { label: "Flight Planner Web UI", href: "/docs/recipes/flight-planner-web-ui" },
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

// biome-ignore format: docs inventory guards read one item per line
export const APP_DOCS_NAV = [
  {
    label: "Get started",
    items: [
      { label: "What is b4app?", href: "/docs/app" },
      { label: "Install and sign in", href: "/docs/app/install" },
      { label: "Connect Codex", href: "/docs/app/codex" },
      { label: "Connect Claude Code", href: "/docs/app/claude-code" },
    ],
  },
  {
    label: "Use the app",
    items: [
      { label: "Your first conversation", href: "/docs/app/first-conversation" },
      { label: "Manage your work", href: "/docs/app/manage-work" },
    ],
  },
  {
    label: "iPhone",
    items: [
      { label: "Use b4app on your iPhone", href: "/docs/app/iphone" },
    ],
  },
  {
    label: "Accounts and help",
    items: [
      { label: "Accounts, privacy, and sync", href: "/docs/app/accounts-and-data" },
      { label: "Troubleshooting", href: "/docs/app/troubleshooting" },
    ],
  },
  {
    label: "B4 agents",
    items: [
      { label: "Use a B4 agent", href: "/docs/app/b4-agents" },
    ],
  },
] as const

/** One navigation source for desktop, mobile, search and no-script links. */
export function navFor(area: DocsArea): readonly DocsNavSection[] {
  return area === "app" ? APP_DOCS_NAV : DOCS_NAV
}

// Flat ordered list of pages — used for prev/next navigation.
type JourneyDocsPage = (typeof DOCS_NAV)[number]["items"][number]
type AppDocsPage = (typeof APP_DOCS_NAV)[number]["items"][number]
type ApiDocsPage = (typeof API_REFERENCE_PAGES)[number]

export const DOCS_PAGES: readonly JourneyDocsPage[] = DOCS_NAV.flatMap(
  (section) => section.items as readonly JourneyDocsPage[],
)

export const APP_DOCS_PAGES: readonly AppDocsPage[] = APP_DOCS_NAV.flatMap(
  (section) => section.items as readonly AppDocsPage[],
)

export const ALL_DOCS_PAGES: readonly (JourneyDocsPage | AppDocsPage | ApiDocsPage)[] = [
  ...DOCS_PAGES,
  ...APP_DOCS_PAGES,
].flatMap((page): readonly (JourneyDocsPage | AppDocsPage | ApiDocsPage)[] =>
  page.href === "/docs/api" ? [page, ...API_REFERENCE_PAGES] : [page],
)

export type DocsPageHref = (typeof ALL_DOCS_PAGES)[number]["href"]

export interface DocsCrumb {
  readonly label: string
  readonly href?: string
}

/** Breadcrumbs retain framework API hierarchy and identify the current audience. */
export function breadcrumbsFor(href: string): readonly DocsCrumb[] {
  const area = docsArea(href)
  if (!area) return [{ label: "Docs" }]
  const home = area === "app" ? "/docs/app" : "/docs/getting-started"
  const label = area === "app" ? "App" : "Framework"
  const ancestors: DocsCrumb[] = [
    { label: "Docs", href: "/docs" },
    href === home ? { label } : { label, href: home },
  ]
  if (href === home) return ancestors
  const reference = API_REFERENCE_PAGES.find((p) => p.href === href)
  if (reference)
    return [
      ...ancestors,
      { label: "Reference" },
      { label: reference.parent.label, href: reference.parent.href },
      { label: reference.label },
    ]
  const section = navFor(area).find((s) => s.items.some((p) => p.href === href))
  const page = section?.items.find((p) => p.href === href)
  return [
    ...ancestors,
    ...(section ? [{ label: section.label }] : []),
    ...(page ? [{ label: page.label }] : []),
  ]
}

export function siblingsFor(href: string): {
  readonly prev: DocsNavItem | null
  readonly next: DocsNavItem | null
} {
  const pages: readonly DocsNavItem[] = docsArea(href) === "app" ? APP_DOCS_PAGES : DOCS_PAGES
  const idx = pages.findIndex((p) => p.href === href)
  if (idx < 0) return { prev: null, next: null }
  return { prev: pages[idx - 1] ?? null, next: pages[idx + 1] ?? null }
}
