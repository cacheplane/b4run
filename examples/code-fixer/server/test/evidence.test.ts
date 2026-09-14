import { expect, it } from "vitest"
import { redactEvidence, verdict } from "../src/blueprint/evidence.ts"

it("removes known secrets and host paths from nested evidence", () => {
  expect(
    redactEvidence(
      { output: "secret-value-123 /private/work/file", children: ["secret-value-123"] },
      ["secret-value-123"],
      ["/private/work"],
    ),
  ).toEqual({ output: "[redacted] [host-path]/file", children: ["[redacted]"] })
})
it("requires all independent criteria and distinguishes approval pending", () => {
  expect(
    verdict(
      {
        visible: true,
        independent: true,
        scope: true,
        reproduced: true,
        verified: true,
        approval: true,
      },
      true,
    ),
  ).toEqual({ passed: true, status: "approval-pending" })
  expect(
    verdict(
      {
        visible: false,
        independent: true,
        scope: true,
        reproduced: true,
        verified: true,
        approval: true,
      },
      false,
    ).passed,
  ).toBe(false)
})
