/**
 * The four shapes a route's index.ts can export, each as the same hello route.
 * Every panel shows a real fixture under shapes/fixtures/ (a small B4 app);
 * route-shapes.test.ts pins the text, runs each one, and asks the framework's
 * own route discovery which shape it is.
 */
export type ShapeId = "agent" | "workflow" | "graph" | "chain"

export interface RouteShape {
  readonly id: ShapeId
  /** The one line that makes this shape, as the export reads. */
  readonly export: string
  /** One sentence under the code. */
  readonly strip: string
  /** A docs page and one of its heading anchors. */
  readonly docsHref: string
  readonly docsLabel: string
  /** The fixture the panel shows, relative to the repository root. */
  readonly origin: string
}

/** Where every shape's file would live in the scaffolded app. */
export const SHAPE_PATH = "src/app/hello/index.ts"
export const SHAPES_APP = "apps/web/app/components/homepage/shapes/fixtures/"

/** The section's own links, below the switcher. */
export const shapeLinks = [
  { href: "/docs/routes#route-entry", label: "Routes" },
  { href: "/docs/migrating-from-langgraph#stategraph--route", label: "Migrating from LangGraph" },
] as const

export const routeShapes: readonly RouteShape[] = [
  {
    id: "agent",
    export: "export default agent({ … })",
    strip: "The model decides which tools to call, and when.",
    docsHref: "/docs/agents#a-minimal-agent",
    docsLabel: "Agents",
    origin: `${SHAPES_APP}src/app/agent/index.ts`,
  },
  {
    id: "workflow",
    export: "export async function workflow(input, ctx)",
    strip: "You write the steps, and the route's tools are plain function calls.",
    docsHref: "/docs/routes#workflow",
    docsLabel: "Workflows",
    origin: `${SHAPES_APP}src/app/workflow/index.ts`,
  },
  {
    id: "graph",
    export: "export const graph = new StateGraph(…).compile()",
    strip: "Raw LangGraph, with your own state, nodes and edges.",
    docsHref: "/docs/routes#graph",
    docsLabel: "Graphs",
    origin: `${SHAPES_APP}src/app/graph/index.ts`,
  },
  {
    id: "chain",
    export: "export const chain = RunnableSequence.from([…])",
    strip: "One LangChain chain that runs its steps in order.",
    docsHref: "/docs/routes#chain",
    docsLabel: "Chains",
    origin: `${SHAPES_APP}src/app/chain/index.ts`,
  },
]
