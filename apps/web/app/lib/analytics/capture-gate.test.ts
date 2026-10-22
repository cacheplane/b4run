import { describe, expect, it } from "vitest"
import { shouldCaptureSignals } from "./capture-gate"

describe("shouldCaptureSignals", () => {
  it.each([
    [{ key: "phc_x", host: "b4.run", captureAnywhere: false }, true],
    [{ key: "phc_x", host: "www.b4.run", captureAnywhere: false }, true],
    [{ key: "phc_x", host: "WWW.B4.RUN", captureAnywhere: false }, true],
    [{ key: "phc_x", host: "b4-run-git-x.vercel.app", captureAnywhere: false }, false],
    [{ key: "phc_x", host: "localhost:3000", captureAnywhere: false }, false],
    [{ key: "phc_x", host: undefined, captureAnywhere: false }, false],
    [{ key: "phc_x", host: "localhost:3000", captureAnywhere: true }, true],
    [{ key: undefined, host: "b4.run", captureAnywhere: true }, false],
    [{ key: "   ", host: "b4.run", captureAnywhere: false }, false],
  ])("shouldCaptureSignals(%o) -> %s", (input, expected) => {
    expect(shouldCaptureSignals(input)).toBe(expected)
  })
})
