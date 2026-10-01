import { describe, expect, it } from "vitest"
import { bundleDigest } from "../src/lib/domain/digest.ts"
import {
  BundlePayloadSchema,
  DraftPrBundleDeliverySchema,
  freezeBundle,
} from "../src/lib/review/bundle.ts"

const receipt = {
  id: "rc-1",
  workOrderId: "wo-0123456789abcdef",
  candidateDigest: "c".repeat(64),
  verifierIdentity: "docker",
  policyDigest: "e".repeat(64),
  environmentIdentity: "env-1",
  verdict: "pass" as const,
  checks: [
    {
      id: "visible",
      acceptanceIds: [],
      verdict: "pass" as const,
      evidence: [{ id: "out", digest: "f".repeat(64) }],
    },
  ],
  issuedAt: "2026-10-01T00:00:00.000Z",
}
const freezeInput = {
  workOrderId: "wo-0123456789abcdef",
  repositoryId: "wo-0123456789abcdef",
  baselineDigest: "a".repeat(64),
  specificationDigest: "b".repeat(64),
  policyDigest: "e".repeat(64),
  candidateDigest: "c".repeat(64),
  receipt,
  destinationId: "/state/exports",
  frozenAt: "2026-10-01T00:00:01.000Z",
  origin: {
    kind: "issue" as const,
    repository: "cacheplane/b4run",
    number: 912,
    bodyDigest: "0".repeat(64),
  },
  pin: "7".repeat(40),
  taskDigest: "d".repeat(64),
  oracleReceiptId: "rc-0",
}
const DRAFT_PR = {
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pathPrefix: ".",
  issueStateAtCreate: "open" as const,
}

describe("the bundle", () => {
  it("freezes an export-local bundle exactly as before rung 4, with no delivery key", () => {
    const bundle = freezeBundle(freezeInput)
    // Computed with the freeze at 216befd5a: every bundle frozen before rung 4 still digests
    // to the digest it was approved under.
    expect(bundle.digest).toBe("c7c751845529b7250882912d501ae38fa97e4db80ca0299157c32ba7d69008e6")
    expect(Object.keys(bundle.payload)).not.toContain("delivery")
    expect(BundlePayloadSchema.parse(bundle.payload).operation).toBe("export-local")
  })

  it("binds a draft-PR delivery into the digest, every field of it", () => {
    const bundle = freezeBundle({ ...freezeInput, delivery: DRAFT_PR })
    const payload = BundlePayloadSchema.parse(bundle.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: "github:cacheplane/b4run:refs/heads/factory/wo-0123456789abcdef",
      delivery: DRAFT_PR,
    })
    expect(bundleDigest(payload)).toBe(bundle.digest)
    const digests = new Set([bundle.digest, freezeBundle(freezeInput).digest])
    for (const [field, value] of [
      ["repository", "cacheplane/other"],
      ["baseBranch", "next"],
      ["pathPrefix", "packages"],
      ["issueStateAtCreate", "closed"],
    ] as const)
      digests.add(
        freezeBundle({ ...freezeInput, delivery: { ...DRAFT_PR, [field]: value } }).digest,
      )
    // The branch is factory/<work order id>, so another branch is another work order's.
    digests.add(
      freezeBundle({
        ...freezeInput,
        workOrderId: "wo-fedcba9876543210",
        delivery: { ...DRAFT_PR, branch: "factory/wo-fedcba9876543210" },
      }).digest,
    )
    expect(digests.size).toBe(7)
  })

  it("refuses a draft-PR payload whose destination or branch is not its own", () => {
    const payload = BundlePayloadSchema.parse(
      freezeBundle({ ...freezeInput, delivery: DRAFT_PR }).payload,
    )
    expect(BundlePayloadSchema.safeParse(payload).success).toBe(true)
    expect(
      BundlePayloadSchema.safeParse({
        ...payload,
        destinationId: "github:cacheplane/other:refs/heads/factory/wo-0123456789abcdef",
      }).success,
    ).toBe(false)
    expect(
      BundlePayloadSchema.safeParse({
        ...payload,
        destinationId: "github:cacheplane/b4run:refs/heads/factory/wo-fedcba9876543210",
        delivery: { ...DRAFT_PR, branch: "factory/wo-fedcba9876543210" },
      }).success,
    ).toBe(false)
  })

  it("refuses at freeze a draft-PR bundle whose branch is not its work order's", () => {
    expect(() =>
      freezeBundle({
        ...freezeInput,
        delivery: { ...DRAFT_PR, branch: "factory/wo-fedcba9876543210" },
      }),
    ).toThrow(/factory\/<the payload's work order id>/)
  })

  it("refuses a draft-PR path prefix that is not one canonical relative path", () => {
    for (const pathPrefix of ["./x", "x/", "/x", "..", "a/../b", ""])
      expect(
        DraftPrBundleDeliverySchema.safeParse({ ...DRAFT_PR, pathPrefix }).success,
        JSON.stringify(pathPrefix),
      ).toBe(false)
    for (const pathPrefix of [".", "packages/cli"])
      expect(DraftPrBundleDeliverySchema.safeParse({ ...DRAFT_PR, pathPrefix }).success).toBe(true)
  })

  it("refuses a draft-PR bundle with no pin", () => {
    expect(() => freezeBundle({ ...freezeInput, pin: null, delivery: DRAFT_PR })).toThrow(/pin/)
  })
})
