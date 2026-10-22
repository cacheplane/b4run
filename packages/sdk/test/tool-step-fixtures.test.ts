import { describe, expect, it } from "vitest"
import { foldToolStepEvents, TOOL_STEP_FIXTURES } from "../src/testing/index.ts"

describe("tool-step fixture corpus", () => {
  it("publishes exactly the agreed fixture names, in order", () => {
    expect(TOOL_STEP_FIXTURES.map((fixture) => fixture.name)).toEqual([
      "metadata-lifecycle",
      "custom-only-lifecycle",
      "legacy-custom-step",
      "step-before-start",
      "failed-step-beats-later-result",
      "denied-clears-label",
      "message-step-beats-call-step",
      "run-error-settles-open",
      "cancelled-run-settles-open",
      "interrupt-keeps-pending-open",
      "unknown-status-falls-back",
      "provider-web-search-with-citations",
      "frames-only-no-step",
      "result-completes-running-step",
      "success-run-leaves-open-steps",
      "cancelled-run-ignores-pending-ids",
      "result-then-failed-step",
      "result-error-fails-running-step",
      "restart-reopens-cancelled-step",
      "late-result-keeps-cancelled",
      "held-step-dropped-at-run-end",
      "completed-without-label-drops-running-label",
      "late-running-adds-nothing-to-settled",
      "running-after-frame-result-stays-completed",
      "denied-after-frame-result-is-denied",
    ])
  })

  for (const fixture of TOOL_STEP_FIXTURES) {
    it(`folds ${fixture.name} to its expected view`, () => {
      expect(foldToolStepEvents(fixture.events)).toEqual(fixture.expected)
    })
  }

  it("does not mutate the fixture events", () => {
    const before = JSON.stringify(TOOL_STEP_FIXTURES)

    for (const fixture of TOOL_STEP_FIXTURES) foldToolStepEvents(fixture.events)

    expect(JSON.stringify(TOOL_STEP_FIXTURES)).toBe(before)
  })
})
