import { afterEach, describe, expect, it } from "vitest"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { pinDiffBase } from "../src/lib/review/pin-diff-base.ts"
import { loadTaskRecipe } from "../src/lib/targets/catalog.ts"
import { emptyImageRegistry, useImages } from "./static-images.ts"

let restore: (() => void) | undefined
afterEach(() => restore?.())

describe("the export review's pin diff", () => {
  it("reads the target's files at the pin on a host that has built no image of it", () => {
    restore = useImages(emptyImageRegistry())
    const task = loadTaskRecipe("cli-flags")
    const base = pinDiffBase({ taskId: "cli-flags", pin: null } as unknown as WorkOrderRow)
    expect(base.label).toBe(`pin ${task.target.pin.slice(0, 12)}`)
    const path = task.manifest.allowedSourcePaths[0] as string
    expect(base.read(path).kind).toBe("bytes")
  })
})
