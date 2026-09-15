import { expect, it } from "vitest"
import { assessQualification } from "../fixtures/qualify.ts"

it("requires intended baseline failure and both passing repair suites", () => {
  expect(
    assessQualification(
      "unknown option",
      { status: 1, output: "unknown option --dry-run" },
      { status: 0, output: "pass" },
      { status: 0, output: "pass" },
    ),
  ).toBe(true)
  for (const status of [0, null]) {
    expect(
      assessQualification(
        "unknown option",
        { status, output: "unknown option" },
        { status: 0, output: "pass" },
        { status: 0, output: "pass" },
      ),
    ).toBe(false)
  }
  expect(
    assessQualification(
      "unknown option",
      { status: 1, output: "module missing" },
      { status: 0, output: "pass" },
      { status: 0, output: "pass" },
    ),
  ).toBe(false)
  expect(
    assessQualification(
      "unknown option",
      { status: 1, output: "unknown option" },
      { status: 1, output: "failed" },
      { status: 0, output: "pass" },
    ),
  ).toBe(false)
  expect(
    assessQualification(
      "unknown option",
      { status: 1, output: "unknown option" },
      { status: 0, output: "pass" },
      { status: 1, output: "failed" },
    ),
  ).toBe(false)
})
