import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import * as authority from "../recovery/authority.mjs"
import { canonicalPolicyBytes, RECOVERY_POLICY_PATH } from "../recovery/policy.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const current = "a".repeat(40),
  baseline = "b".repeat(40)
const repairPath = "scripts/release/recovery-verifier-repairs/v0.8.24.json"
const contractRoot = "scripts/release/recovery-fence-contracts"

import { verifierRepairFixture } from "./support/recovery-verifier-repair-fixture.mjs"

test("original executors retain exact closure admission without repair reads", async () => {
  const f = await verifierRepairFixture()
  const result = await authority.validateRecoveryVerifier(
    { ...f.request, controllerSha: baseline },
    f.git,
  )
  assert.equal(result.mode, "original")
  assert.equal(result.actualClosureSha256, f.record.originalClosureSha256)
})
test("repaired executors replace the original candidate fence digest and expose their actual closure", async () => {
  const f = await verifierRepairFixture()
  const result = await authority.validateRecoveryVerifier(f.request, f.git)
  assert.equal(result.mode, "repair")
  assert.equal(result.actualClosureSha256, f.record.replacementClosureSha256)
  assert.deepEqual(result.approvedContractDigests, [f.record.replacementContractSha256])
  assert.deepEqual(result.adoption, f.record.adoption)
})
for (const [name, mutate] of Object.entries({
  absent: (f) => f.files.delete(`${current}:${repairPath}`),
  malformed: (f) => f.files.set(`${current}:${repairPath}`, "{}"),
  noncanonical: (f) => f.files.set(`${current}:${repairPath}`, JSON.stringify(f.record)),
  unknownField: (f) => {
    f.record.extra = true
    f.refresh()
  },
  candidate: (f) => {
    f.record.candidate.releaseId = "100"
    f.request.candidate = { ...f.request.candidate, releaseId: "2" }
    f.refresh()
  },
  policy: (f) => {
    f.record.policySha256 = "9".repeat(64)
    f.refresh()
  },
  policyBytes: (f) =>
    f.files.set(`${baseline}:${RECOVERY_POLICY_PATH}`, JSON.stringify(f.request.policy, null, 2)),
  ancestry: (f) => {
    f.git.isAncestor = async () => false
  },
  baselineClosure: (f) => {
    f.record.originalClosureSha256 = "9".repeat(64)
    f.refresh()
  },
  currentClosure: (f) => {
    f.record.replacementClosureSha256 = "9".repeat(64)
    f.refresh()
  },
  oldHash: (f) => {
    f.record.inputs[0].oldSha256 = "9".repeat(64)
    f.refresh()
  },
  newHash: (f) => {
    f.record.inputs[0].newSha256 = "9".repeat(64)
    f.refresh()
  },
  inputs: (f) => {
    f.record.inputs.pop()
    f.refresh()
  },
  oldContract: (f) => {
    f.record.originalContractSha256 = "9".repeat(64)
    f.refresh()
  },
  newContract: (f) => {
    f.record.replacementContractSha256 = "9".repeat(64)
    f.refresh()
  },
  adoptionExecutor: (f) => {
    f.record.adoption.assetName = `recovery-v2-adoption-${current}-10-1-11.json`
    f.refresh()
  },
}))
  test(`repair rejects ${name} drift`, async () => {
    const f = await verifierRepairFixture()
    mutate(f)
    await assert.rejects(() => authority.validateRecoveryVerifier(f.request, f.git))
  })
for (const [name, mutate] of Object.entries({
  workflow: (c) => {
    c.topology[0].sources[0].workflowSha256 = "9".repeat(64)
  },
  disposition: (c) => {
    c.topology[0].disposition = "fenced-legacy"
  },
  topology: (c) => {
    c.topology[0].workflowId = "999"
  },
  evidence: (c) => {
    c.evidenceSha256 = "9".repeat(64)
  },
  probe: (c) => {
    c.probeClosure.push({ path: "other", sha256: "9".repeat(64) })
  },
  inputPath: (c) => {
    c.topology[0].sources[0].executionInputs[0].path = "other"
  },
  historical: (c) => {
    c.topology[0].sources[0].source = { kind: "commit", sha: baseline }
  },
}))
  test(`repair preserves contract ${name}`, async () => {
    const f = await verifierRepairFixture()
    mutate(f.replacementContract)
    const raw = canonicalPolicyBytes(f.replacementContract).toString()
    f.record.replacementContractSha256 = hash(raw)
    f.files.set(`${current}:${contractRoot}/${f.record.replacementContractSha256}.json`, raw)
    f.refresh()
    await assert.rejects(() => authority.validateRecoveryVerifier(f.request, f.git))
  })

for (const probe of [
  "scripts/release/recovery/policy.mjs",
  "scripts/release/test/support/recovery-github-probe.mjs",
])
  test(`repair rejects changed actual probe bytes at ${probe} with a recomputed repair manifest`, async () => {
    const f = await verifierRepairFixture()
    for (const ref of [baseline, current])
      if (!f.files.has(`${ref}:${probe}`))
        f.files.set(`${ref}:${probe}`, "// original outside closure probe\n")
    f.originalContract.probeClosure = [
      { path: probe, sha256: hash(f.files.get(`${baseline}:${probe}`)) },
    ]
    f.replacementContract.probeClosure = structuredClone(f.originalContract.probeClosure)
    f.record.originalContractSha256 = hash(canonicalPolicyBytes(f.originalContract))
    f.record.replacementContractSha256 = hash(canonicalPolicyBytes(f.replacementContract))
    f.request.policy.fence.contracts = [f.record.originalContractSha256]
    f.request.rawPolicy = canonicalPolicyBytes(f.request.policy).toString()
    f.record.policySha256 = hash(f.request.rawPolicy)
    for (const ref of [baseline, current]) {
      f.files.set(`${ref}:${RECOVERY_POLICY_PATH}`, f.request.rawPolicy)
      f.files.set(
        `${ref}:${contractRoot}/${f.record.originalContractSha256}.json`,
        canonicalPolicyBytes(f.originalContract).toString(),
      )
    }
    f.files.set(
      `${current}:${contractRoot}/${f.record.replacementContractSha256}.json`,
      canonicalPolicyBytes(f.replacementContract).toString(),
    )
    f.files.set(`${current}:${probe}`, "// changed service probe input\n")
    const input = f.record.inputs.find((input) => input.path === probe)
    if (input) input.newSha256 = hash(f.files.get(`${current}:${probe}`))
    const { hashVerifierClosure } = await import("../recovery/policy.mjs")
    f.record.replacementClosureSha256 = await hashVerifierClosure(
      { controllerSha: current, inputs: f.request.policy.verifierClosure.inputs },
      f.git.showFile,
    )
    f.refresh()
    await assert.rejects(() => authority.validateRecoveryVerifier(f.request, f.git), /probe input/)
  })
