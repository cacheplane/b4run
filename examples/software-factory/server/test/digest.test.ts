import { describe, expect, it } from "vitest"
import { bundleDigest, candidateDigest, canon } from "../src/domain/digest.ts"

const changes = { "src/b.ts": "two\n", "src/a.ts": "one\n" }
const baseline = "a".repeat(64)

describe("canon", () => {
  it("is insensitive to key insertion order", () => {
    expect(canon({ b: 1, a: 2 })).toBe(canon({ a: 2, b: 1 }))
  })

  it("is sensitive to values and to nesting", () => {
    expect(canon({ a: { b: 1 } })).not.toBe(canon({ a: { b: 2 } }))
    expect(canon({ a: { b: 1 } })).not.toBe(canon({ "a.b": 1 }))
  })
})

describe("candidateDigest", () => {
  it("is stable, hex, and independent of change insertion order", () => {
    const one = candidateDigest({ workspaceId: "w", baselineDigest: baseline, changes })
    const two = candidateDigest({
      workspaceId: "w",
      baselineDigest: baseline,
      changes: { "src/a.ts": "one\n", "src/b.ts": "two\n" },
    })
    expect(one).toMatch(/^[a-f0-9]{64}$/)
    expect(one).toBe(two)
  })

  it("changes when any input changes", () => {
    const base = candidateDigest({ workspaceId: "w", baselineDigest: baseline, changes })
    expect(candidateDigest({ workspaceId: "x", baselineDigest: baseline, changes })).not.toBe(base)
    expect(candidateDigest({ workspaceId: "w", baselineDigest: "b".repeat(64), changes })).not.toBe(
      base,
    )
    expect(
      candidateDigest({
        workspaceId: "w",
        baselineDigest: baseline,
        changes: { "src/a.ts": "one\n" },
      }),
    ).not.toBe(base)
  })
})

describe("bundleDigest", () => {
  const input = {
    repositoryId: "cli-flags",
    baselineDigest: baseline,
    specificationDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    environmentIdentity: "sha256:deadbeef",
    candidateDigest: "e".repeat(64),
    evidence: [{ id: "independent", digest: "f".repeat(64) }],
    operation: "export-local" as const,
    destinationId: "/out",
  }

  it("is stable and hex", () => {
    expect(bundleDigest(input)).toMatch(/^[a-f0-9]{64}$/)
    expect(bundleDigest(input)).toBe(bundleDigest({ ...input, evidence: [...input.evidence] }))
  })

  it("changes when the policy or the environment changes, with the same bytes", () => {
    expect(bundleDigest({ ...input, policyDigest: "0".repeat(64) })).not.toBe(bundleDigest(input))
    expect(bundleDigest({ ...input, environmentIdentity: "sha256:other" })).not.toBe(
      bundleDigest(input),
    )
  })

  it("is domain-separated from a candidate digest over the same shape", () => {
    // A candidate digest must never be mistakable for a bundle digest.
    expect(bundleDigest(input)).not.toBe(
      candidateDigest({ workspaceId: input.repositoryId, baselineDigest: baseline, changes: {} }),
    )
  })
})
