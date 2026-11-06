import { expect, test } from "vitest"
import { validateSource } from "../../../lib/turn-inspector/source"

const source = {
  path: "examples/navlog/server/src/app/navlog/index.ts",
  digest: "a".repeat(64),
  revision: "b".repeat(40),
  language: "typescript",
  ranges: [{ start: 1, end: 2, moment: "read-profile" }],
}
test("validates pinned source and rejects invalid line ranges and paths", () => {
  expect(validateSource("one\ntwo", source)).toEqual(["one", "two"])
  expect(() => validateSource("one", source)).toThrow(/range/)
  expect(() => validateSource("one\ntwo", { ...source, path: "examples/navlog/../.env" })).toThrow(
    /metadata/,
  )
  expect(() => validateSource("x".repeat(256001), source)).toThrow(/large/)
})
