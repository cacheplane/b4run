import { describe, expect, it } from "vitest"
import { boundImageOf, dispatchPreparing, imageWaitBoundMs } from "../src/lib/controller/images.ts"
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

describe("imageWaitBoundMs", () => {
  it("is the longest journalled wait bound, or 0", () => {
    expect(imageWaitBoundMs([event("transition", {})])).toBe(0)
    expect(
      imageWaitBoundMs([
        event("image_prepare_started", { deadlineMs: 5_400_000 }),
        event("image_prepare_started", { deadlineMs: 90_000 }),
      ]),
    ).toBe(5_400_000)
  })

  it("ignores a bound that is not a finite, non-negative number", () => {
    for (const deadlineMs of [Number.POSITIVE_INFINITY, Number.NaN, -5, "90000"])
      expect(imageWaitBoundMs([event("image_prepare_started", { deadlineMs })])).toBe(0)
    expect(
      imageWaitBoundMs([
        event("image_prepare_started", { deadlineMs: -1 }),
        event("image_prepare_started", { deadlineMs: 90_000 }),
      ]),
    ).toBe(90_000)
  })
})

describe("dispatchPreparing", () => {
  it("is true from an image build's start until the dispatch moves the row or refuses", () => {
    expect(dispatchPreparing([])).toBe(false)
    expect(dispatchPreparing([event("image_prepare_started", {})])).toBe(true)
    // The build ending is not the dispatch ending: the thread is still to be created.
    expect(
      dispatchPreparing([
        event("image_prepare_started", {}),
        event("image_prepared", {}),
        event("image_bound", {}),
      ]),
    ).toBe(true)
    for (const end of ["transition", "dispatch_refused"])
      expect(
        dispatchPreparing([
          event("image_prepare_started", {}),
          event("image_prepared", {}),
          event(end, {}),
        ]),
      ).toBe(false)
    expect(
      dispatchPreparing([
        event("image_prepare_started", {}),
        event("dispatch_refused", {}),
        event("image_prepare_started", {}),
      ]),
    ).toBe(true)
  })

  it("ends when reconciliation writes off a build a restart interrupted, and only then", () => {
    const started = event("image_prepare_started", {})
    expect(
      dispatchPreparing([started, event("image_prepare_aborted", { reason: "restart" })]),
    ).toBe(false)
    // A cancel's abort is followed by the cancel's transition or the dispatch's refusal.
    expect(
      dispatchPreparing([
        started,
        event("image_prepare_aborted", { reason: "Error: Run cancelled" }),
      ]),
    ).toBe(true)
  })
})
