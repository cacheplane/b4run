import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  canonicalPolicyBytes,
  hashVerifierClosure,
  RECOVERY_POLICY_PATH,
} from "../../recovery/policy.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const repairPath = "scripts/release/recovery-verifier-repairs/v0.8.24.json"
const contractRoot = "scripts/release/recovery-fence-contracts"
export async function verifierRepairFixture(options = {}) {
  const current = options.current ?? "a".repeat(40),
    baseline = options.baseline ?? "b".repeat(40)
  const candidate = options.candidate ?? {
    repository: "example/b4",
    repositoryId: "1",
    version: "0.8.24",
    candidateSha: "c".repeat(40),
    tag: "v0.8.24",
    tagObjectSha: "d".repeat(40),
    releaseId: "2",
    manifestSha256: "e".repeat(64),
    releaseRecordSha256: "f".repeat(64),
  }
  const policy = JSON.parse(await readFile(new URL("../../recovery/policy.json", import.meta.url)))
  policy.status = "ADMITTED"
  const files = new Map()
  const changed = "scripts/release/smoke/runtime-targets.mjs"
  for (const path of policy.verifierClosure.inputs) {
    files.set(`${baseline}:${path}`, options.source ?? `original:${path}\n`)
    files.set(
      `${current}:${path}`,
      path === changed ? `repaired:${path}\n` : (options.source ?? `original:${path}\n`),
    )
  }
  const read = async ({ ref, path }) => {
    const key = `${ref}:${path}`
    assert.ok(files.has(key), `Missing ${key}`)
    return files.get(key)
  }
  const originalContract = {
    schemaVersion: 1,
    kind: "recovery-legacy-fence-contract",
    repository: candidate.repository,
    repositoryId: candidate.repositoryId,
    candidateSourceSha: candidate.candidateSha,
    mechanism: "github-workflow-disable-v1",
    apiVersion: "2022-11-28",
    evidenceSha256: "1".repeat(64),
    probeClosure: [],
    fixtures: [],
    topology: [
      {
        workflowId: "1",
        workflow: ".github/workflows/ci.yml",
        disposition: "nonwriter",
        sources: [
          {
            source: { kind: "current-default" },
            workflowSha256: "2".repeat(64),
            executionInputs: [
              {
                path: changed,
                sha256: hash(files.get(`${baseline}:${changed}`)),
              },
            ],
          },
        ],
      },
    ],
  }
  const replacementContract = structuredClone(originalContract)
  replacementContract.topology[0].sources[0].executionInputs[0].sha256 = hash(
    files.get(`${current}:${changed}`),
  )
  const originalContractSha256 = hash(canonicalPolicyBytes(originalContract))
  const replacementContractSha256 = hash(canonicalPolicyBytes(replacementContract))
  policy.fence.contracts = [originalContractSha256]
  policy.verifierClosure.sha256 = await hashVerifierClosure(
    { controllerSha: baseline, inputs: policy.verifierClosure.inputs },
    read,
  )
  const policyRaw = canonicalPolicyBytes(policy).toString()
  for (const ref of [baseline, current]) {
    files.set(`${ref}:${RECOVERY_POLICY_PATH}`, policyRaw)
    files.set(
      `${ref}:${contractRoot}/${originalContractSha256}.json`,
      canonicalPolicyBytes(originalContract).toString(),
    )
  }
  files.set(
    `${current}:${contractRoot}/${replacementContractSha256}.json`,
    canonicalPolicyBytes(replacementContract).toString(),
  )
  const record = {
    schemaVersion: 1,
    kind: "recovery-verifier-repair",
    candidate,
    policySha256: hash(policyRaw),
    baselineControllerSha: baseline,
    originalClosureSha256: policy.verifierClosure.sha256,
    replacementClosureSha256: await hashVerifierClosure(
      { controllerSha: current, inputs: policy.verifierClosure.inputs },
      read,
    ),
    inputs: policy.verifierClosure.inputs.map((path) => ({
      path,
      oldSha256: hash(files.get(`${baseline}:${path}`)),
      newSha256: hash(files.get(`${current}:${path}`)),
    })),
    originalContractSha256,
    replacementContractSha256,
    adoption: {
      assetName: `recovery-v2-adoption-${baseline}-10-1-11.json`,
      id: "12",
      size: 1000,
      sha256: "3".repeat(64),
    },
  }
  const refresh = () =>
    files.set(`${current}:${repairPath}`, canonicalPolicyBytes(record).toString())
  refresh()
  const request = {
    candidate,
    controllerSha: current,
    policy,
    rawPolicy: policyRaw,
  }
  const git = { showFile: read, isAncestor: async () => true }
  return {
    request,
    git,
    record,
    files,
    refresh,
    baseline,
    current,
    originalContract,
    replacementContract,
  }
}
