import { describe, expect, it } from "vitest"
import {
  bundleDigest,
  candidateDigest,
  canon,
  DigestInputError,
  environmentIdentityDigest,
  policyDigest,
} from "../src/lib/domain/digest.ts"

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
    workOrderId: "wo-2026-09-18-0001",
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
      environment: {
        identity: "e".repeat(64),
        pin: "1".repeat(40),
        root: ".",
        captureInclude: [] as string[],
        defectPatchSha256: null,
      },
    }
    expect(() => policyDigest({ ...base, checks: { visible: { assertion: "ok" } } })).not.toThrow()
    expect(() =>
      policyDigest({ ...base, checks: { visible: { assertion: "ok", extra: undefined } } }),
    ).toThrow(DigestInputError)
    expect(() => policyDigest({ ...base, checks: { visible: { assertion: undefined } } })).toThrow(
      DigestInputError,
    )
  })

  it("throws on non-plain objects instead of silently canoning to {}", () => {
    const first = () => canon({ when: new Date("2024-01-01T00:00:00.000Z") })
    const second = () => canon({ when: new Date("2024-06-01T00:00:00.000Z") })
    expect(first).toThrow(DigestInputError)
    expect(second).toThrow(DigestInputError)
  })

  it("throws on a Map", () => {
    expect(() => canon({ m: new Map([["a", 1]]) })).toThrow(DigestInputError)
  })

  it("still accepts a plain object", () => {
    expect(() => canon({ a: { b: [1, 2, { c: 3 }] } })).not.toThrow()
  })

  it("throws on a __proto__ key, naming it, even when JSON.parse produced it as an own property", () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"b":2}}')
    // JSON.parse gives "__proto__" as a genuine own property; object-literal
    // syntax would not. Confirm the fixture actually exercises that.
    expect(Object.getOwnPropertyNames(parsed)).toContain("__proto__")
    expect(() => canon(parsed)).toThrow(DigestInputError)
    expect(() => canon(parsed)).toThrow(/__proto__/)
  })

  it("produces an unchanged digest for a legitimate nested structure", () => {
    const value = { a: 1, b: { c: [3, 2, 1], d: null }, e: "text" }
    expect(canon(value)).toBe('{"a":1,"b":{"c":[3,2,1],"d":null},"e":"text"}')
  })
})

describe("policyDigest v2", () => {
  const base = {
    checks: { visible: { runner: "vitest", assertions: ["a"] } },
    allowedSourcePaths: ["packages/devkit/src/testing/process.ts"],
    immutablePaths: ["packages/devkit/package.json"],
    environment: {
      identity: "e".repeat(64),
      pin: "1".repeat(40),
      root: ".",
      captureInclude: ["packages/devkit"],
      defectPatchSha256: "2".repeat(64),
    },
  }
  const one = policyDigest(base)

  for (const key of Object.keys(base.environment) as (keyof typeof base.environment)[]) {
    it(`moves when environment.${key} moves`, () => {
      const current = base.environment[key]
      const moved = Array.isArray(current)
        ? [...current, "x"]
        : current === null
          ? "3".repeat(64)
          : `${current}x`
      expect(
        policyDigest({ ...base, environment: { ...base.environment, [key]: moved } }),
      ).not.toBe(one)
    })
  }

  it("moves when defectPatchSha256 goes from a hash to null", () => {
    expect(
      policyDigest({ ...base, environment: { ...base.environment, defectPatchSha256: null } }),
    ).not.toBe(one)
  })

  it("is order-independent over the include list", () => {
    expect(
      policyDigest({ ...base, environment: { ...base.environment, captureInclude: ["b", "a"] } }),
    ).toBe(
      policyDigest({ ...base, environment: { ...base.environment, captureInclude: ["a", "b"] } }),
    )
  })
})

describe("environmentIdentityDigest", () => {
  const image = {
    localId: `sha256:${"a".repeat(64)}`,
    platform: "linux/arm64",
    baseManifestDigest: `sha256:${"b".repeat(64)}`,
    dockerfileSha256: "c".repeat(64),
    lockfileSha256: "d".repeat(64),
    pnpmVersion: "10.33.0",
  }
  const pin = "e".repeat(40)
  const one = environmentIdentityDigest(image, pin)

  it("is a 64-hex digest", () => {
    expect(one).toMatch(/^[a-f0-9]{64}$/)
  })

  for (const key of Object.keys(image) as (keyof typeof image)[]) {
    it(`moves when ${key} moves`, () => {
      expect(environmentIdentityDigest({ ...image, [key]: `${image[key]}-x` }, pin)).not.toBe(one)
    })
  }

  it("moves when the pin moves, with every image input the same", () => {
    expect(environmentIdentityDigest(image, "f".repeat(40))).not.toBe(one)
  })
})
