import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parseRecoveryFenceContract } from "../recovery/fence.mjs"
import {
  FENCE_FIXTURES,
  fenceCanonical,
  fenceDigest,
  validateRecoveryFenceEvidence,
} from "../recovery/fence-evidence.mjs"
import { canonicalPolicyBytes, parseRecoveryPolicy } from "../recovery/policy.mjs"
import { canonicalRecoveryBytes, parseRecovery } from "../recovery/schema.mjs"

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url))

test("committed v0.8.24 admission binds exact intent, complete topology and actual service witness", async () => {
  const policy = parseRecoveryPolicy(await read("scripts/release/recovery/policy.json"))
  assert.equal(policy.status, "ADMITTED")
  assert.equal(policy.fence.contracts.length, 1)
  const intentBytes = await read("scripts/release/recovery-adoptions/v0.8.24.json")
  const intent = parseRecovery(intentBytes, { kind: "recovery-adoption-intent" })
  assert.deepEqual(intentBytes, canonicalRecoveryBytes(intent))
  assert.equal(intent.policySha256, fenceDigest(canonicalPolicyBytes(policy)))
  assert.equal(intent.candidate.releaseId, "382873833")
  assert.equal(intent.candidate.repositoryId, "1210070282")
  assert.equal(intent.candidate.candidateSha, "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea")
  const digest = policy.fence.contracts[0]
  const raw = await read(`scripts/release/recovery-fence-contracts/${digest}.json`)
  assert.equal(fenceDigest(raw), digest)
  const contract = parseRecoveryFenceContract(raw)
  assert.equal(contract.candidateSourceSha, intent.candidate.candidateSha)
  assert.equal(contract.repository, intent.candidate.repository)
  assert.equal(contract.repositoryId, intent.candidate.repositoryId)
  assert.equal(contract.topology.length, 17)
  assert.equal(contract.topology.filter((entry) => entry.disposition === "fenced-legacy").length, 7)
  for (const input of contract.probeClosure)
    assert.equal(fenceDigest(await read(input.path)), input.sha256, input.path)
  const fixtureBytes = {}
  for (const revision of ["current", "historical"])
    fixtureBytes[revision] = (await read(FENCE_FIXTURES[revision].path)).toString("utf8")
  const witness = await read(
    `scripts/release/recovery-fence-evidence/${contract.evidenceSha256}.json`,
  )
  assert.equal(fenceDigest(witness), contract.evidenceSha256)
  validateRecoveryFenceEvidence(witness, {
    fixtureBytes,
    probeClosureSha256: fenceDigest(canonicalPolicyBytes(contract.probeClosure)),
  })
  for (const entry of contract.topology.filter(
    (entry) => entry.disposition === "platform-nonwriter",
  )) {
    const reviewBytes = await read(
      `scripts/release/recovery-platform-reviews/${entry.reviewSha256}.json`,
    )
    assert.equal(fenceDigest(reviewBytes), entry.reviewSha256)
    const review = JSON.parse(reviewBytes)
    assert.deepEqual(reviewBytes, fenceCanonical(review))
    assert.equal(review.candidateSourceSha, contract.candidateSourceSha)
    assert.equal(review.repositoryId, contract.repositoryId)
    assert.equal(review.workflowId, entry.workflowId)
    assert.equal(review.workflow, entry.workflow)
    for (const input of review.configuration)
      assert.equal(fenceDigest(await read(input.path)), input.sha256, input.path)
  }
})
