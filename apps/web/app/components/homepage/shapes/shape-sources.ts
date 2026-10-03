import type { ShapeId } from "./route-shapes"
import sources from "./shape-sources.json"

/** Each shape's index.ts; route-shapes.test.ts pins it to the fixture at `origin`. */
export const shapeSources: Readonly<Record<ShapeId, string>> = sources
