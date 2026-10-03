// packages/ag-ui/test/content-parts-shape.test.ts
import type { ContentPart } from "@ag-ui/core"
import type { B4ContentPart } from "@b4run/sdk"
import { expect, test } from "vitest"

/**
 * The SDK's part type is a structural copy of the protocol's. Either direction
 * failing to assign means a 1.x addition widened one side: update
 * `packages/sdk/src/content-parts.ts` deliberately rather than letting the
 * runtime carry a shape it does not know.
 */
type AssignableBothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const pinned: AssignableBothWays<ContentPart, B4ContentPart> = true

test("B4ContentPart and ContentPart are mutually assignable", () => {
  expect(pinned).toBe(true)
})
