import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRoutes } from "@b4run/core/node"
import { isB4Agent } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { DOCS_INDEX } from "../../docs/search-index"
import agentRoute from "./fixtures/src/app/agent/index"
import { chain } from "./fixtures/src/app/chain/index"
import { graph } from "./fixtures/src/app/graph/index"
import { workflow } from "./fixtures/src/app/workflow/index"
import greet from "./fixtures/src/app/workflow/tools/greet"
import { routeShapes, SHAPES_APP, type ShapeId, shapeLinks } from "./route-shapes"
import { shapeSources } from "./shape-sources"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const TEMPLATE = "packages/devkit/templates/app-basic/"

/** What each shape's entry starts with, as the docs write it. */
const EXPORTS: Readonly<Record<ShapeId, readonly [string, string]>> = {
  agent: ["export default agent(", "apps/web/content/docs/agents.mdx"],
  workflow: ["export async function workflow(", "apps/web/content/docs/routes.mdx"],
  graph: ["export const graph = new StateGraph(", "apps/web/content/docs/routes.mdx"],
  chain: ["export const chain = RunnableSequence.from([", "apps/web/content/docs/routes.mdx"],
}

describe("the route shapes are real routes", () => {
  it("offers the four shapes in the order the docs name them", () => {
    expect(routeShapes.map((shape) => shape.id)).toEqual(["agent", "workflow", "graph", "chain"])
  })

  it("shows each fixture exactly as it is on disk", () => {
    for (const shape of routeShapes) {
      expect(shapeSources[shape.id], shape.origin).toBe(read(shape.origin))
    }
  })

  it("uses the scaffold's own hello agent, tool and config", () => {
    expect(read(`${SHAPES_APP}src/app/agent/index.ts`)).toBe(
      read(`${TEMPLATE}src/app/hello/index.ts`),
    )
    for (const route of ["agent", "workflow"]) {
      expect(read(`${SHAPES_APP}src/app/${route}/tools/greet.ts`), route).toBe(
        read(`${TEMPLATE}src/app/hello/tools/greet.ts`),
      )
    }
    expect(read(`${SHAPES_APP}b4.config.ts`)).toBe(read(`${TEMPLATE}b4.config.ts`))
  })

  it("is the shape it claims, by B4's own route discovery", async () => {
    const manifest = await discoverRoutes({ appRoot: resolve(repoRoot, SHAPES_APP) })
    expect(
      Object.fromEntries(manifest.routes.map((route) => [route.pathname, route.kind])),
    ).toEqual({ "/agent": "agent", "/chain": "chain", "/graph": "graph", "/workflow": "workflow" })
  }, 60_000)

  it("greets the same way in every shape that runs without a model", async () => {
    expect(isB4Agent(agentRoute)).toBe(true)
    const ctx = { signal: new AbortController().signal, tools: { greet }, fs: undefined as never }
    await expect(workflow({ name: " Ada " }, ctx)).resolves.toEqual({ message: "Hello, Ada!" })
    await expect(graph.invoke({ name: "Ada" })).resolves.toEqual({
      name: "Ada",
      message: "Hello, Ada!",
    })
    await expect(chain.invoke({ name: " Ada " })).resolves.toEqual({ message: "Hello, Ada!" })
  })

  it("names each shape by the export its file and the docs both use, in one sentence", () => {
    for (const shape of routeShapes) {
      const [entry, doc] = EXPORTS[shape.id]
      expect(shapeSources[shape.id], shape.id).toContain(entry)
      expect(read(doc), shape.id).toContain(entry)
      expect(shape.export.replace(/[ …]+/g, ""), shape.id).toContain(
        entry.replace(/\(.*$|\s+/g, ""),
      )
      expect(shape.strip.match(/[.!?](?=\s|$)/g), shape.id).toHaveLength(1)
      expect(shape.strip, shape.id).not.toContain("—")
    }
  })

  it("links to docs headings that exist", () => {
    for (const href of [
      ...routeShapes.map((shape) => shape.docsHref),
      ...shapeLinks.map((link) => link.href),
    ]) {
      const [path, anchor] = href.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, href).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        href,
      ).toContain(anchor)
    }
  })
})
