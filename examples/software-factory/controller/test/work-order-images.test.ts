import { describe, expect, it } from "vitest"
import { boundImageOf } from "../src/lib/controller/images.ts"
import type { FactoryEvent } from "../src/lib/domain/work-order.ts"

const image = (n: string) => ({
  localId: `sha256:${n.repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
})
const bound = (n: string) => ({
  targetId: "devkit",
  pin: "1".repeat(40),
  key: n.repeat(64).slice(0, 64),
  tag: "b4-factory-devkit:111111111111-cccccccccccc",
  image: image(n),
})
let seq = 0
const event = (type: string, payload: Record<string, unknown>): FactoryEvent =>
  ({ seq: ++seq, workOrderId: "wo-1", type, payload, at: new Date().toISOString() }) as FactoryEvent

describe("boundImageOf", () => {
  it("is the last image_bound in the journal, or undefined", () => {
    expect(boundImageOf([event("transition", {})])).toBeUndefined()
    const events = [
      event("image_bound", bound("a")),
      event("oracle_receipt", {}),
      event("image_bound", bound("e")),
    ]
    expect(boundImageOf(events)).toEqual(bound("e"))
  })

  it("refuses a malformed binding rather than guessing", () => {
    expect(() =>
      boundImageOf([event("image_bound", { ...bound("a"), image: { localId: "x" } })]),
    ).toThrow()
  })
})
