import "server-only"
import { highlightCode } from "../highlight"
import { routeShapes, SHAPE_PATH, type ShapeId } from "./route-shapes"
import { shapeSources } from "./shape-sources"

/** Each shape's index.ts, highlighted on the server: one HTML string per line. */
export async function prepareRouteShapes(): Promise<Readonly<Record<ShapeId, readonly string[]>>> {
  const entries = await Promise.all(
    routeShapes.map(async (shape) => {
      const code = await highlightCode(shapeSources[shape.id], "typescript", SHAPE_PATH, "")
      return [shape.id, code.lines] as const
    }),
  )
  return Object.fromEntries(entries) as Record<ShapeId, readonly string[]>
}
