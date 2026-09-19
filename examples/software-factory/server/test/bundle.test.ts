import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Receipt } from "../src/domain/work-order.ts"
import { freezeBundle } from "../src/review/bundle.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { suiteChecks } from "../src/verification/docker-verifier.ts"
import { loadPolicy } from "../src/verification/policy.ts"

const receipt = {
  id: "rc-1",
  workOrderId: "wo-1",
  candidateDigest: "a".repeat(64),
  verifierIdentity: "docker:sha256:abc",
  policyDigest: "b".repeat(64),
  environmentIdentity: "sha256:abc",
  verdict: "pass" as const,
  checks: [
    { id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] },
    {
      id: "independent",
      acceptanceIds: ["two"],
      verdict: "pass" as const,
      evidence: [{ id: "independent-output", digest: "c".repeat(64) }],
    },
  ],
  issuedAt: "2026-09-18T00:00:00.000Z",
}

describe("loadPolicy", () => {
  it("derives the specification and policy digests from fixture data", () => {
    const policy = loadPolicy("cli-flags")
    expect(policy.specificationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.acceptanceIds.length).toBeGreaterThan(0)
    expect(policy.allowedSourcePaths).toEqual(["src/cli.ts"])
  })

  it("moves the policy digest when the inventory changes, and not otherwise", () => {
    const one = loadPolicy("cli-flags")
    const two = loadPolicy("cli-flags")
    expect(two.policyDigest).toBe(one.policyDigest)
  })
})

describe("freezeBundle", () => {
  const base = {
    workOrderId: "wo-1",
    repositoryId: "cli-flags",
    baselineDigest: "d".repeat(64),
    specificationDigest: "e".repeat(64),
    policyDigest: receipt.policyDigest,
    candidateDigest: receipt.candidateDigest,
    receipt,
    destinationId: "/out",
    frozenAt: "2026-09-18T00:00:01.000Z",
  }

  it("freezes a bundle whose digest covers every input", () => {
    const bundle = freezeBundle(base)
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.candidateDigest).toBe(receipt.candidateDigest)
    expect(bundle.receiptId).toBe("rc-1")
    expect(bundle.payload.environmentIdentity).toBe("sha256:abc")
    expect(bundle.payload.operation).toBe("export-local")
    expect(bundle.payload.workOrderId).toBe("wo-1")
  })

  it("moves the digest when only the work order differs, with identical bytes", () => {
    const one = freezeBundle(base)
    const two = freezeBundle({
      ...base,
      workOrderId: "wo-2",
      receipt: { ...receipt, workOrderId: "wo-2" },
    })
    expect(two.digest).not.toBe(one.digest)
    expect(two.payload.workOrderId).toBe("wo-2")
  })

  it("carries the evidence the receipt referenced, sorted", () => {
    const bundle = freezeBundle(base)
    expect(bundle.payload.evidence).toEqual([{ id: "independent-output", digest: "c".repeat(64) }])
  })

  it("moves the digest when the policy or the environment moves, with identical bytes", () => {
    const one = freezeBundle(base)
    expect(freezeBundle({ ...base, policyDigest: "0".repeat(64) }).digest).not.toBe(one.digest)
    expect(
      freezeBundle({ ...base, receipt: { ...receipt, environmentIdentity: "sha256:other" } })
        .digest,
    ).not.toBe(one.digest)
  })

  it("moves the digest when only the receipt or the freeze time differs, with identical bytes", () => {
    // The registry keys bundles by digest and treats a repeated digest as the same record.
    // That is only true if the digest covers everything the record holds: a bundle frozen
    // over a second receipt for the same claim must be a second bundle, not a silent alias
    // of the first pointing at a receipt it never had.
    const one = freezeBundle(base)
    const otherReceipt = freezeBundle({ ...base, receipt: { ...receipt, id: "rc-2" } })
    expect(otherReceipt.digest).not.toBe(one.digest)
    expect(otherReceipt.payload.receiptId).toBe("rc-2")
    const later = freezeBundle({ ...base, frozenAt: "2026-09-18T00:00:02.000Z" })
    expect(later.digest).not.toBe(one.digest)
    expect(later.payload.frozenAt).toBe("2026-09-18T00:00:02.000Z")
  })

  it("refuses to freeze anything but a passing receipt", () => {
    expect(() => freezeBundle({ ...base, receipt: { ...receipt, verdict: "fail" } })).toThrow(
      /pass/,
    )
    expect(() =>
      freezeBundle({ ...base, receipt: { ...receipt, verdict: "inconclusive" } }),
    ).toThrow(/pass/)
  })

  it("refuses a receipt for a different candidate", () => {
    expect(() => freezeBundle({ ...base, candidateDigest: "9".repeat(64) })).toThrow(/candidate/)
  })

  it("refuses conflicting evidence reported under the same id", () => {
    const conflicting = {
      ...receipt,
      checks: [
        ...receipt.checks,
        {
          id: "extra",
          acceptanceIds: ["three"],
          verdict: "pass" as const,
          evidence: [{ id: "independent-output", digest: "9".repeat(64) }],
        },
      ],
    }
    expect(() => freezeBundle({ ...base, receipt: conflicting })).toThrow(/conflicting evidence/)
  })
})

/**
 * The join the two modules never had. `freezeBundle` was only ever handed receipts a test
 * wrote by hand, or the fake verifier's evidence-free ones, so nothing noticed that the real
 * verifier named every check's evidence `output`: two checks, two digests, one id, which
 * `freezeBundle` refuses. Every real passing run therefore ended in the verifying phase's
 * backstop as `verification_inconclusive`. This freezes a receipt whose checks are built by
 * the verifier's own helper, over two genuinely different artifacts.
 */
describe("freezing a receipt shaped as the real verifier emits one", () => {
  const directories: string[] = []
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("freezes a passing two-suite receipt and carries both suites' evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-bundle-"))
    directories.push(dir)
    const artifacts = createArtifactStore(join(dir, "artifacts"))
    const policy = loadPolicy("cli-flags")
    // Two suites, two different outputs, therefore two different digests: exactly the
    // condition a shared evidence id turns into a refusal.
    const visible = await artifacts.put("visible suite output\n")
    const independent = await artifacts.put("independent suite output\n")
    expect(visible.digest).not.toBe(independent.digest)

    const real: Receipt = {
      id: "rc-real-1",
      workOrderId: "wo-1",
      candidateDigest: "a".repeat(64),
      verifierIdentity: "docker:b4-code-fixer:fixture-v1",
      policyDigest: policy.policyDigest,
      environmentIdentity: "b4-code-fixer:fixture-v1",
      verdict: "pass",
      checks: suiteChecks({
        visible: {
          verdict: "pass",
          acceptanceIds: policy.checks.visible.assertions,
          outputDigest: visible.digest,
        },
        independent: {
          verdict: "pass",
          acceptanceIds: policy.checks.independent.assertions,
          outputDigest: independent.digest,
        },
      }),
      issuedAt: "2026-09-18T00:00:00.000Z",
    }

    const bundle = freezeBundle({
      workOrderId: "wo-1",
      repositoryId: "cli-flags",
      baselineDigest: "d".repeat(64),
      specificationDigest: policy.specificationDigest,
      policyDigest: policy.policyDigest,
      candidateDigest: real.candidateDigest,
      receipt: real,
      destinationId: "/out",
      frozenAt: "2026-09-18T00:00:01.000Z",
    })

    expect(bundle.payload.evidence).toEqual([
      { id: "independent/output", digest: independent.digest },
      { id: "visible/output", digest: visible.digest },
    ])
    // Both suites' output is reachable from the bundle: an approver can read what each check
    // actually printed, not just that two checks ran.
    expect(await artifacts.read(independent.digest)).toBe("independent suite output\n")
  })
})
