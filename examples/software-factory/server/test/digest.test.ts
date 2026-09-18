import { describe, expect, it } from "vitest"
import {
  bundleDigest,
  candidateDigest,
  canon,
  DigestInputError,
  policyDigest,
} from "../src/domain/digest.ts"

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

describe("canon rejects input it cannot hash injectively", () => {
  it("throws on an object with an undefined value, naming the path", () => {
    expect(() => canon({ checks: { visible: { file: undefined } } })).toThrow(DigestInputError)
    expect(() => canon({ checks: { visible: { file: undefined } } })).toThrow(
      /checks\.visible\.file/,
    )
  })

  it("throws on a function value", () => {
    expect(() => canon({ a: () => 1 })).toThrow(DigestInputError)
  })

  it("throws on NaN", () => {
    expect(() => canon({ a: Number.NaN })).toThrow(DigestInputError)
    expect(() => canon(Number.POSITIVE_INFINITY)).toThrow(DigestInputError)
    expect(() => canon(Number.NEGATIVE_INFINITY)).toThrow(DigestInputError)
  })

  it("throws on a lone surrogate", () => {
    expect(() => canon("\uD800")).toThrow(DigestInputError)
    expect(() => canon("\uDC00")).toThrow(DigestInputError)
    expect(() => canon("𐀀")).not.toThrow()
  })

  it("still accepts null and nested arrays", () => {
    expect(() => canon({ a: null, b: [1, [2, null], 3] })).not.toThrow()
    expect(canon({ a: null })).toBe('{"a":null}')
  })

  it("makes two policies differing only by an undefined-valued key both throw, instead of colliding", () => {
    const base = {
      allowedSourcePaths: ["src/a.ts"],
      immutablePaths: [] as string[],
    }
    expect(() => policyDigest({ ...base, checks: { visible: { assertion: "ok" } } })).not.toThrow()
    expect(() =>
      policyDigest({ ...base, checks: { visible: { assertion: "ok", extra: undefined } } }),
    ).toThrow(DigestInputError)
    expect(() => policyDigest({ ...base, checks: { visible: { assertion: undefined } } })).toThrow(
      DigestInputError,
    )
  })
})
