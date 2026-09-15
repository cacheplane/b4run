import { expect, it } from "vitest"
import { candidateDigest, validateCandidate } from "../src/review/candidate.ts"

const original = {
  version: 1 as const,
  workspaceId: "workspace",
  sourceDigest: "source",
  changes: { "src/cli.ts": "repair" },
}
it("binds approval to workspace provenance and exact candidate bytes", () => {
  const candidate = { ...original, receiptDigest: candidateDigest(original) }
  expect(validateCandidate(candidate)).toEqual(candidate)
  for (const override of [
    { workspaceId: "other" },
    { sourceDigest: "other" },
    { changes: { "src/cli.ts": "other" } },
  ])
    expect(() => validateCandidate({ ...candidate, ...override })).toThrow()
})
it("rejects unexpected candidate properties", () => {
  expect(() =>
    validateCandidate({ ...original, receiptDigest: candidateDigest(original), path: "/tmp/out" }),
  ).toThrow()
})
