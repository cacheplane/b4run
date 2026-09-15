import { expect, it } from "vitest"
import { failureStatus, redactEvidence, verdict } from "../evaluation/evidence.ts"

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

it("distinguishes a spent step budget from infrastructure and patch failures", () => {
  expect(failureStatus(Object.assign(new Error("limit"), { name: "GraphRecursionError" }))).toBe(
    "step-limit",
  )
  expect(failureStatus(Object.assign(new Error("scope"), { name: "PatchRejectedError" }))).toBe(
    "behavior-failed",
  )
  expect(failureStatus(new Error("connection lost"))).toBe("infrastructure-failed")
  expect(failureStatus("unexpected error")).toBe("infrastructure-failed")
})
