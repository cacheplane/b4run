import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

const { validateRecoveryVerifier } = await importHistoricalReleaseModule(
  "scripts/release/recovery/authority.mjs",
)
const { parseRecoveryFenceContract } = await importHistoricalReleaseModule(
  "scripts/release/recovery/fence.mjs",
)
const { FENCE_FIXTURES, fenceCanonical, fenceDigest, validateRecoveryFenceEvidence } =
  await importHistoricalReleaseModule("scripts/release/recovery/fence-evidence.mjs")
const { canonicalPolicyBytes, parseRecoveryPolicy } = await importHistoricalReleaseModule(
  "scripts/release/recovery/policy.mjs",
)
const { canonicalRecoveryBytes, parseRecovery } = await importHistoricalReleaseModule(
  "scripts/release/recovery/schema.mjs",
)

import {
  HISTORICAL_RELEASE_REF,
  importHistoricalReleaseModule,
  readHistoricalReleaseFile,
} from "./support/frozen-history.mjs"

const read = async (path) => readHistoricalReleaseFile(path)

const gitRead = (ref, path) =>
  execFileSync("git", ["show", `${ref}:${path}`], { maxBuffer: 8 * 1024 * 1024 })

async function verifyCommittedAdmission({ currentRead = read, historicalRead = gitRead } = {}) {
  const read = currentRead
  const historical = new Map()
  const frozen = async (ref, path) => {
    const key = `${ref}:${path}`
    if (!historical.has(key)) historical.set(key, await historicalRead(ref, path))
    return historical.get(key)
  }
  const rawPolicy = (await read("scripts/release/recovery/policy.json")).toString("utf8")
  const policy = parseRecoveryPolicy(rawPolicy)
  assert.equal(policy.status, "ADMITTED")
  assert.equal(policy.fence.contracts.length, 1)
  const intentBytes = await read("scripts/release/recovery-adoptions/v0.8.24.json")
  const intent = parseRecovery(intentBytes, { kind: "recovery-adoption-intent" })
  assert.deepEqual(intentBytes, canonicalRecoveryBytes(intent))
  assert.equal(intent.policySha256, fenceDigest(canonicalPolicyBytes(policy)))
  assert.equal(intent.candidate.releaseId, "382873833")
  assert.equal(intent.candidate.repositoryId, "1210070282")
  assert.equal(intent.candidate.candidateSha, "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea")
  const controllerSha = HISTORICAL_RELEASE_REF
  const admission = await validateRecoveryVerifier(
    {
      candidate: intent.candidate,
      controllerSha,
      policy,
      rawPolicy,
    },
    {
      showFile: async ({ ref, path }) =>
        ref === controllerSha
          ? (await read(path)).toString("utf8")
          : (await frozen(ref, path)).toString("utf8"),
      isAncestor: ({ ancestor, descendant }) => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant])
          return true
        } catch {
          return false
        }
      },
    },
  )
  assert.equal(admission.mode, "repair")
  assert.equal(admission.approvedContractDigests.length, 1)
  const digest = admission.approvedContractDigests[0]
  const raw = await read(`scripts/release/recovery-fence-contracts/${digest}.json`)
  assert.equal(fenceDigest(raw), digest)
  const contract = parseRecoveryFenceContract(raw)
  assert.equal(contract.candidateSourceSha, intent.candidate.candidateSha)
  assert.equal(contract.repository, intent.candidate.repository)
  assert.equal(contract.repositoryId, intent.candidate.repositoryId)
  assert.equal(contract.topology.length, 17)
  assert.equal(contract.topology.filter((entry) => entry.disposition === "fenced-legacy").length, 7)
  const repair = JSON.parse(await read("scripts/release/recovery-verifier-repairs/v0.8.24.json"))
  const originalBytes = await frozen(
    repair.baselineControllerSha,
    `scripts/release/recovery-fence-contracts/${repair.originalContractSha256}.json`,
  )
  assert.equal(fenceDigest(originalBytes), repair.originalContractSha256)
  const original = parseRecoveryFenceContract(originalBytes)
  let originalBindings = 0
  // This historical-record audit checks original current-default bindings at the
  // reviewed baseline. Runtime fencing separately checks the live default bytes.
  for (const entry of original.topology)
    for (const source of entry.sources ?? []) {
      const ref =
        source.source.kind === "current-default" ? repair.baselineControllerSha : source.source.sha
      assert.equal(
        fenceDigest(await frozen(ref, entry.workflow)),
        source.workflowSha256,
        entry.workflow,
      )
      originalBindings++
      for (const input of source.executionInputs) {
        assert.equal(fenceDigest(await frozen(ref, input.path)), input.sha256, input.path)
        originalBindings++
      }
    }
  const closureInputs = new Set(policy.verifierClosure.inputs)
  // The shared validator already requires the exact original-to-replacement
  // transformation. Check actual replacement bytes for its complete manifest:
  // current verifier inputs remain live; other inputs retain their frozen source.
  for (const entry of contract.topology)
    for (const source of entry.sources ?? []) {
      const current = source.source.kind === "current-default"
      const ref = current ? repair.baselineControllerSha : source.source.sha
      assert.equal(
        fenceDigest(await frozen(ref, entry.workflow)),
        source.workflowSha256,
        entry.workflow,
      )
      for (const input of source.executionInputs) {
        const bytes =
          current && closureInputs.has(input.path)
            ? await read(input.path)
            : await frozen(ref, input.path)
        assert.equal(fenceDigest(bytes), input.sha256, input.path)
      }
    }
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
    for (const input of review.configuration) {
      assert.equal(
        fenceDigest(await frozen(repair.baselineControllerSha, input.path)),
        input.sha256,
        input.path,
      )
      originalBindings++
    }
  }
  assert.equal(
    originalBindings,
    277,
    "complete original workflow, execution, and platform bindings",
  )
}

test("frozen Dawn v0.8.24 admission binds exact intent, complete topology and actual service witness", async () => {
  await verifyCommittedAdmission()
})

test("future package versions do not reinterpret the frozen recovery contract", async () => {
  await verifyCommittedAdmission({
    currentRead: async (path) => {
      const bytes = await read(path)
      if (path !== "packages/core/package.json") return bytes
      return Buffer.from(
        `${JSON.stringify({ ...JSON.parse(bytes), version: "0.8.99" }, null, 2)}\n`,
      )
    },
  })
})

test("a future package version cannot conceal changed frozen baseline bytes", async () => {
  await assert.rejects(
    () =>
      verifyCommittedAdmission({
        historicalRead: (ref, path) => {
          const bytes = gitRead(ref, path)
          return path === "packages/core/package.json"
            ? Buffer.concat([bytes, Buffer.from("\n")])
            : bytes
        },
      }),
    /packages\/core\/package\.json/,
  )
})

test("frozen contract checks still reject changed current approved verifier bytes", async () => {
  await assert.rejects(
    () =>
      verifyCommittedAdmission({
        currentRead: async (path) => {
          const bytes = await read(path)
          return path === "scripts/release/smoke-containment.mjs"
            ? Buffer.concat([bytes, Buffer.from("\n")])
            : bytes
        },
      }),
    /verifier repair policy\/closure differs/,
  )
})
