import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { policyDigest } from "../src/lib/domain/digest.ts"
import type { Receipt } from "../src/lib/domain/work-order.ts"
import { freezeBundle } from "../src/lib/review/bundle.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask, type Task } from "../src/lib/targets/catalog.ts"
import { loadPolicy, policyEnvironment } from "../src/lib/verification/policy.ts"
import { suiteChecks } from "../src/lib/verification/receipt.ts"

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
    const policy = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
    expect(policy.specificationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.acceptanceIds.length).toBeGreaterThan(0)
    expect(policy.allowedSourcePaths).toEqual(["src/cli.ts"])
  })

  it("moves the policy digest when the inventory changes, and not otherwise", () => {
    const one = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
    const two = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
    expect(two.policyDigest).toBe(one.policyDigest)
  })

  it("binds the target's environment, so a changed image or baseline definition moves the policy", () => {
    const policy = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
    expect(policy.environment.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.environment.pin).toMatch(/^[a-f0-9]{40}$/)
    expect(policy.environment.defectPatchSha256).toBeNull()
    expect(policy.environment.root).toBe(
      "examples/software-factory/server/fixtures/cli-flags/project",
    )
    expect(policy.environment.captureInclude).toEqual(policy.task.target.capture.include)
  })

  it("digests the image it is given, so a work order's policy is its binding's", () => {
    const image = loadTask("cli-flags").target.image
    const other = { ...image, localId: `sha256:${"7".repeat(64)}` }
    const bound = loadPolicy("cli-flags", other)
    expect(bound.task.target.image).toEqual(other)
    expect(bound.environment.identity).not.toBe(loadPolicy("cli-flags", image).environment.identity)
    expect(bound.policyDigest).not.toBe(loadPolicy("cli-flags", image).policyDigest)
  })

  it("hashes the defect patch into the environment when the task has one", () => {
    // Both branches from one real task: the hash follows the patch bytes, and a task
    // without a defect patch hashes to nothing.
    const real = loadTask("devkit-spawn-deadline")
    expect(policyEnvironment(real).defectPatchSha256).toBe(
      createHash("sha256")
        .update(real.defectPatch as string)
        .digest("hex"),
    )
    const withDefect = { ...real, defectPatch: "--- a/x\n+++ b/x\n" }
    const environment = policyEnvironment(withDefect)
    expect(environment.defectPatchSha256).toBe(
      createHash("sha256").update("--- a/x\n+++ b/x\n").digest("hex"),
    )
    expect(policyEnvironment({ ...real, defectPatch: null }).defectPatchSha256).toBeNull()
  })

  it("moves the policy digest when the checks, the allowed paths or the immutable paths move", () => {
    const base = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
    const digestFor = (task: Task) =>
      policyDigest({
        checks: task.checks,
        allowedSourcePaths: task.manifest.allowedSourcePaths,
        immutablePaths: task.manifest.immutablePaths,
        environment: policyEnvironment(task),
      })
    const task = base.task
    expect(digestFor(task)).toBe(base.policyDigest)
    expect(
      digestFor({
        ...task,
        checks: { ...task.checks, visible: { ...task.checks.visible, assertions: ["other"] } },
      }),
    ).not.toBe(base.policyDigest)
    expect(
      digestFor({
        ...task,
        manifest: { ...task.manifest, allowedSourcePaths: ["src/other.ts"] },
      }),
    ).not.toBe(base.policyDigest)
    expect(digestFor({ ...task, manifest: { ...task.manifest, immutablePaths: [] } })).not.toBe(
      base.policyDigest,
    )
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
    origin: { kind: "catalog" as const },
    pin: null,
    taskDigest: null,
    oracleReceiptId: null,
  }

  it("freezes a bundle whose digest covers every input", () => {
    const bundle = freezeBundle(base)
    // A catalog work order: no pin, no generated task, no oracle proof, and the payload
    // says so rather than omitting the fields, so the digest covers their absence too.
    expect(bundle.payload).toMatchObject({
      origin: { kind: "catalog" },
      pin: null,
      taskDigest: null,
      oracleReceiptId: null,
    })
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

  it("moves the digest when the origin, the pin, the generated task or the oracle proof moves", () => {
    // Approving the export consents to the issue text, the approved task and the candidate
    // together (spec §6.6): each of the four must move the digest on its own.
    const one = freezeBundle(base)
    const origin = {
      kind: "issue" as const,
      repository: "cacheplane/b4run",
      number: 778,
      bodyDigest: "1".repeat(64),
    }
    const issue = freezeBundle({
      ...base,
      origin,
      pin: "a".repeat(40),
      taskDigest: "2".repeat(64),
      oracleReceiptId: "rc-oracle",
    })
    expect(issue.digest).not.toBe(one.digest)
    expect(issue.payload).toMatchObject({
      origin,
      pin: "a".repeat(40),
      taskDigest: "2".repeat(64),
      oracleReceiptId: "rc-oracle",
    })
    expect(freezeBundle({ ...base, origin }).digest).not.toBe(one.digest)
    expect(freezeBundle({ ...base, pin: "a".repeat(40) }).digest).not.toBe(one.digest)
    expect(freezeBundle({ ...base, taskDigest: "2".repeat(64) }).digest).not.toBe(one.digest)
    expect(freezeBundle({ ...base, oracleReceiptId: "rc-oracle" }).digest).not.toBe(one.digest)
    expect(
      freezeBundle({ ...base, origin: { ...origin, bodyDigest: "3".repeat(64) } }).digest,
    ).not.toBe(freezeBundle({ ...base, origin }).digest)
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
    const policy = loadPolicy("cli-flags", loadTask("cli-flags").target.image)
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
      origin: { kind: "catalog" },
      pin: null,
      taskDigest: null,
      oracleReceiptId: null,
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
