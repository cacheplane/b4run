// Dormant controller: dependencies are trusted adapters; requests contain no authority.
import { types } from "node:util"
import { captureRecoveryEligibility } from "./authority.mjs"
import {
  buildRecoveryVerificationSet,
  observeRecoveryLaneEvidence,
  readRecoveryEvidencePolicy,
  recoveryEvidenceHash,
  recoveryProvenanceName,
  recoveryVerificationName,
} from "./evidence-proof.mjs"
import { renderRecoveryReleaseBody } from "./metadata.mjs"
import { createRecoveryWorkBudget } from "./observe.mjs"
import { withRecoveryPayloadReuse } from "./payload-reuse.mjs"
import { canonicalPolicyBytes, RECOVERY_RETRY, recoveryMethods } from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LANES,
  snapshotRecoveryData,
} from "./schema.mjs"
import { createRecoveryWriter } from "./writer.mjs"

export async function collectRecoveryEvidence(request, config, dependencies) {
  return withRecoveryPayloadReuse(dependencies, (scoped) =>
    collectRecoveryEvidenceInInvocation(request, config, scoped),
  )
}
export async function collectRecoveryEvidenceStage(request, config, dependencies, previous = null) {
  return withRecoveryPayloadReuse(dependencies, (scoped) =>
    collectRecoveryEvidenceInInvocation(request, config, scoped, { previous }),
  )
}
const EVIDENCE_GROUPS = [
  ["metadata", "published-harness"],
  ["runtime-targets", "scaffold"],
  ["storage"],
]
function completedLanes(current, executor) {
  return RECOVERY_LANES.filter((lane) => {
    const matches = (current.facts.escrow ?? []).filter(
      (entry) =>
        entry.lane.lane === lane &&
        canonicalPolicyBytes(entry.receipt.executor).equals(canonicalPolicyBytes(executor)),
    )
    if (matches.length > 1) throw new Error("Ambiguous accepted lane escrow")
    return matches.length === 1 && matches[0].lane.conclusion === "success"
  })
}
async function collectRecoveryEvidenceInInvocation(request, config, dependencies, staged = null) {
  const finish = (result, stage = null) => (staged ? { result, stage } : result)
  request = snapshotRecoveryData(request, 16384)
  if (Object.keys(request).sort().join(" ") !== "candidate expectedControllerSha intentPath")
    throw new TypeError("Exact recovery evidence request required")
  const observationSource = data(dependencies, "observation")
  const observation = Object.fromEntries(
    ["github", "git", "npm", "npmAuditFactory", "attestations"].map((key) => [
      key,
      data(observationSource, key),
    ]),
  )
  const authorityDependencies = data(dependencies, "authority")
  const clock = recoveryMethods(authorityDependencies, ["now", "sleep"])
  // Start the writer deadline before any collection work; no fresh phase starts after reads.
  const writer = createRecoveryWriter(config, dependencies)
  const budget = createRecoveryWorkBudget(
    { phaseDeadline: clock.now() + RECOVERY_RETRY.phaseDeadlineMs },
    {
      now: clock.now,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
    },
  )
  const observe = async () => {
    const result = await writer.observeRecoveryCandidate(request)
    if (result.outcome === "blocked") throw new Error(result.errors.join("; "))
    return result
  }
  let current = await observe()
  // Accepted selection is a durable chain. Actions retention is irrelevant on replay.
  if (current.phase !== "RECOVERY_ADOPTED") {
    if (current.phase === "NPM_COMPLETE")
      throw new Error("Recovery adoption required before evidence collection")
    return finish(current)
  }
  const proof = await budget.work(() =>
    captureRecoveryEligibility(
      { candidate: request.candidate, expectedControllerSha: request.expectedControllerSha },
      authorityDependencies,
    ),
  )
  const acceptedSelection = Boolean(current.facts.verification)
  const beforeLanes = staged ? completedLanes(current, proof.executor) : []
  if (staged?.previous) {
    if (
      !canonicalPolicyBytes(staged.previous.executor).equals(canonicalPolicyBytes(proof.executor))
    )
      throw new Error("Evidence stage executor changed")
    if (!staged.previous.completedLanes.every((lane) => beforeLanes.includes(lane)))
      throw new Error("Evidence stage progress changed")
  }
  const missingGroup = EVIDENCE_GROUPS.findIndex((lanes) =>
    lanes.some((lane) => !beforeLanes.includes(lane)),
  )
  const group = staged ? (missingGroup < 0 ? 2 : missingGroup) : null
  const targetLanes = staged
    ? EVIDENCE_GROUPS[group].filter((lane) => !beforeLanes.includes(lane))
    : []
  const stageProof = (current) => {
    const afterLanes = completedLanes(current, proof.executor)
    const expected = RECOVERY_LANES.filter(
      (lane) => beforeLanes.includes(lane) || targetLanes.includes(lane),
    )
    if (!canonicalPolicyBytes(afterLanes).equals(canonicalPolicyBytes(expected)))
      throw new Error("Evidence stage did not prove exact lane progress")
    return { executor: proof.executor, completedLanes: afterLanes, group }
  }
  const common = {
    ...request,
    expectedBodySha256: recoveryEvidenceHash(Buffer.from(current.facts.release.body)),
  }
  if (!current.facts.verification) {
    const policy = await budget.work(() =>
      readRecoveryEvidencePolicy(proof.executor, proof.policySha256, observation.git),
    )
    const collected = [],
      errors = []
    for (const lane of RECOVERY_LANES) {
      const existing = (current.facts.escrow ?? []).filter(
        (e) =>
          e.lane.lane === lane &&
          ["controllerSha", "verifierClosureSha256", "workflow", "runId", "runAttempt"].every(
            (key) => e.receipt.executor[key] === proof.executor[key],
          ),
      )
      if (existing.length > 1) throw new Error("Ambiguous accepted lane escrow")
      if (existing.length === 1) {
        if (existing[0].lane.conclusion !== "success") errors.push(`Failed ${lane} lane`)
        continue
      }
      const verified = await budget.work(() =>
        observeRecoveryLaneEvidence(
          {
            candidate: request.candidate,
            executor: proof.executor,
            policy,
            policySha256: proof.policySha256,
            manifestPackages: current.facts.manifestPackages,
            lane,
          },
          observation.github,
          clock,
        ),
      )
      if (verified.missing) {
        errors.push(verified.missing)
        continue
      }
      if (verified.lane.conclusion !== "success") errors.push(`Failed ${lane} lane`)
      collected.push(verified)
    }
    // Every artifact is fully checked before the first write, including all sidecars.
    if (staged && errors.length)
      return finish(snapshotRecoveryData({ ...current, errors }, 16 * 1024 * 1024))
    for (const verified of collected.filter(
      (value) => !staged || targetLanes.includes(value.lane.lane),
    )) {
      const installations = []
      for (const [name, contentBase64] of Object.entries(verified.installations))
        installations.push(await writer.uploadRecoveryAsset({ ...common, name, contentBase64 }))
      const receipt = await writer.uploadRecoveryAsset({
        ...common,
        name: verified.name,
        contentBase64: verified.contentBase64,
      })
      const descriptor = parseRecovery({
        schemaVersion: 2,
        kind: "recovery-provenance",
        candidate: request.candidate,
        policySha256: proof.policySha256,
        executor: proof.executor,
        provenance: verified.provenance,
        receipt,
        installations: installations.sort((a, b) => (a.assetName < b.assetName ? -1 : 1)),
        artifact: verified.artifact,
      })
      await writer.uploadRecoveryAsset({
        ...common,
        name: recoveryProvenanceName(descriptor),
        contentBase64: canonicalRecoveryBytes(descriptor).toString("base64"),
      })
    }
    current = await observe()
    if (errors.length) return finish(snapshotRecoveryData({ ...current, errors }, 16 * 1024 * 1024))
    if (staged) {
      const progress = stageProof(current)
      if (progress.completedLanes.length < RECOVERY_LANES.length) return finish(current, progress)
    }
    const set = buildRecoveryVerificationSet(current, proof.executor)
    await writer.uploadRecoveryAsset({
      ...common,
      name: recoveryVerificationName(proof.executor),
      contentBase64: canonicalRecoveryBytes(set).toString("base64"),
    })
    current = await observe()
  }
  const marker = parseRecovery({
    ...current.facts.marker,
    revision: current.facts.marker.revision + 1,
    phase: "VERIFICATION_COMPLETE",
    verificationSet: current.facts.verification.ref,
  })
  const prefix = current.facts.release.body.split("\n\n<!-- DAWN_RELEASE_CONTROLLER_MARKER\n")[0]
  const result = await writer.updateRecoveryDraft({
    ...common,
    title: current.facts.release.name,
    body: renderRecoveryReleaseBody({ marker, body: prefix }),
  })
  return finish(result, staged && !acceptedSelection ? stageProof(result) : null)
}
function data(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Safe evidence dependency container required")
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw new TypeError("Safe evidence dependency data required")
  return descriptor.value
}
