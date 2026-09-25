/**
 * "The last mile": twelve parts of shipping an agent, and what in B4 handles
 * each. Every `code` excerpt is lines of a real file (`origin`): a fixture
 * under checklist/fixtures/ or the tour's, which the web typecheck compiles,
 * or a basic-template file, which the generated-app harness typechecks.
 * checklist.test.ts pins each excerpt, and runs the handler where one can run.
 */
export type ChecklistId =
  | "schemas"
  | "streaming"
  | "auth"
  | "thread-access"
  | "approval"
  | "sandbox"
  | "memory"
  | "retries"
  | "persistence"
  | "tests"
  | "evals"
  | "inspect"

export interface ChecklistItem {
  readonly id: ChecklistId
  readonly title: string
  /** The front of the tile: the work you would otherwise write. */
  readonly chore: string
  /** The back of the tile: what handles it. One or two sentences. */
  readonly handledBy: string
  /** Where the excerpt lives in the scaffolded app, when it is a file. */
  readonly file: string | null
  /** A few real lines, or the command or endpoints that do the work. */
  readonly code: string
  /** The file the excerpt comes from, relative to the repository root. */
  readonly origin: string
  readonly docsHref: string
  readonly docsLabel: string
}

export const CHECKLIST_FIXTURES = "apps/web/app/components/homepage/checklist/fixtures/"
const TEMPLATE = "packages/devkit/templates/app-basic/"

export const checklist: readonly ChecklistItem[] = [
  {
    id: "schemas",
    title: "Tool schemas",
    chore: "Describe every tool's input as JSON Schema, and keep it in step with the code.",
    handledBy: "b4 typegen reads the tool's TypeScript types and its doc comment.",
    file: "src/app/hello/tools/greet.ts",
    code: "/** Greet someone by name. */\nexport default async (input: { readonly name: string }) => {",
    origin: `${TEMPLATE}src/app/hello/tools/greet.ts`,
    docsHref: "/docs/tools#tool-descriptions",
    docsLabel: "Tools",
  },
  {
    id: "streaming",
    title: "Streaming",
    chore: "Stream tokens and tool calls to a web client as they happen.",
    handledBy: "Every route streams over Agent Protocol and AG-UI.",
    file: null,
    code: "POST /threads/:thread_id/runs/stream\nPOST /agui/{routeId}",
    origin: "apps/web/content/docs/dev-server/agent-protocol.mdx",
    docsHref: "/docs/dev-server/agent-protocol#streaming-over-sse",
    docsLabel: "Agent Protocol",
  },
  {
    id: "auth",
    title: "Auth",
    chore: "Check who is calling before a route runs.",
    handledBy: "One middleware file runs before every route request.",
    file: "src/middleware.ts",
    code: "export default defineMiddleware(async (req) => {",
    origin: `${CHECKLIST_FIXTURES}src/middleware.ts`,
    docsHref: "/docs/middleware#file-location",
    docsLabel: "Middleware",
  },
  {
    id: "thread-access",
    title: "Thread access",
    chore: "Keep one user out of another user's threads.",
    handledBy: "One policy file decides who may create, read, change or delete each thread.",
    file: "src/thread-access.ts",
    code: "export default defineThreadAccess({",
    origin: `${CHECKLIST_FIXTURES}src/thread-access.ts`,
    docsHref: "/docs/thread-access#the-shape",
    docsLabel: "Thread access",
  },
  {
    id: "approval",
    title: "Human approval",
    chore: "Pause a risky tool call until a person says yes.",
    handledBy: "The run pauses, and a person answers once, always or deny.",
    file: "src/app/support/index.ts",
    code: 'tools: { approve: ["refund"] },',
    origin: `${CHECKLIST_FIXTURES}src/app/support/index.ts`,
    docsHref: "/docs/permissions#per-tool-approval",
    docsLabel: "Permissions",
  },
  {
    id: "sandbox",
    title: "Sandboxing",
    chore: "Run the agent's shell commands away from your host.",
    handledBy:
      "The file tools and runBash run in a Docker container, or in a Kubernetes Pod with kubernetesSandbox.",
    file: "b4.config.ts",
    code: 'provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),',
    origin: `${CHECKLIST_FIXTURES}b4.config.sandbox.ts`,
    docsHref: "/docs/sandbox#quickstart",
    docsLabel: "Sandbox",
  },
  {
    id: "memory",
    title: "Memory",
    chore: "Remember facts about a user from one conversation to the next.",
    handledBy: "A memory.ts file gives the agent remember and recall tools.",
    file: "src/app/hello/memory.ts",
    code: 'export default defineMemory({\n  kind: "semantic",',
    origin: "apps/web/app/components/homepage/tour/fixtures/hello/memory.ts",
    docsHref: "/docs/memory/long-term#declare-a-collection",
    docsLabel: "Long-term memory",
  },
  {
    id: "retries",
    title: "Model retries",
    chore: "Retry the model after a rate limit or a dropped connection.",
    handledBy:
      "Model calls that hit a rate limit, a server error or a network error retry with backoff.",
    file: "src/app/support/index.ts",
    code: "retry: { maxAttempts: 5, baseDelay: 500 },",
    origin: `${CHECKLIST_FIXTURES}src/app/support/index.ts`,
    docsHref: "/docs/retry#configuring-retry",
    docsLabel: "Retry",
  },
  {
    id: "persistence",
    title: "Persistence",
    chore: "Keep threads and checkpoints when the server restarts.",
    handledBy:
      "@b4run/postgres-storage gives you the checkpointer, the thread store and the permission store.",
    file: "b4.config.ts",
    code: "checkpointer: postgresCheckpointer({ pool }),\nthreadsStore: createPostgresThreadsStore({ pool }),",
    origin: `${CHECKLIST_FIXTURES}b4.config.postgres.ts`,
    docsHref: "/docs/configuration#postgres-backend",
    docsLabel: "Postgres backend",
  },
  {
    id: "tests",
    title: "Offline tests",
    chore: "Test the agent without paying for a model call.",
    handledBy: "script() fixtures stand in for the model, so npm test needs no API key.",
    file: "test/agent.test.ts",
    code: 'fixtures: script().user("Say hello to Ada").replies("Hello, Ada!"),',
    origin: `${TEMPLATE}test/agent.test.ts.template`,
    docsHref: "/docs/testing-agents#your-scaffolded-app-already-has-a-test",
    docsLabel: "Testing agents",
  },
  {
    id: "evals",
    title: "Evals",
    chore: "Score the agent on a dataset before you ship.",
    handledBy:
      "b4 eval replays each case offline, and b4 eval --record captures new fixtures from the model.",
    file: "src/app/hello/evals/smoke.eval.ts",
    code: 'export default defineEval({\n  name: "greets by name",',
    origin: `${TEMPLATE}src/app/hello/evals/smoke.eval.ts.template`,
    docsHref: "/docs/evals#recording-fixtures-with---record",
    docsLabel: "Evals",
  },
  {
    id: "inspect",
    title: "Inspection",
    chore: "See what the agent has remembered, and govern it.",
    handledBy: "b4 inspect opens the Inspector, a browser view of the app's long-term memory.",
    file: null,
    code: "b4 inspect",
    origin: "apps/web/content/docs/inspector.mdx",
    docsHref: "/docs/inspector#launching",
    docsLabel: "Inspector",
  },
]

/** What the live region says after a tile turns. The count always changes, so the text does. */
export function describeToggle(item: ChecklistItem, open: boolean, opened: number): string {
  const count = `${opened} of ${checklist.length} opened.`
  const done = opened === checklist.length ? " Handled." : ""
  return open
    ? `${item.title}: ${item.handledBy} ${count}${done}`
    : `${item.title} closed. ${count}`
}
