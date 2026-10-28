import assert from "node:assert/strict"
import test from "node:test"

import { correlateReleaseEvidence } from "../evidence.mjs"
import { AUDIT_SHA256, candidate, observationForMarker } from "./support/marker-observation.mjs"

test("ATTACHING is a resumable exact subset and not a completed escrow", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({
      phase: "ATTACHING",
      npmComplete: false,
      smokesComplete: false,
      partialBase: true,
    }),
  )

  assert.equal(evidence.assets.markerPhase, "ATTACHING")
  assert.equal(evidence.assets.escrowResumable, true)
  assert.equal(evidence.assets.escrowComplete, false)
  assert.equal(evidence.assets.draftExact, false)
  assert.equal(Object.hasOwn(evidence.assets, "metadataComplete"), false)
  assert.deepEqual(evidence.conflicts, [])
})

test("AUDIT_VERIFIED correlates the immutable base and exact audit receipts", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({ phase: "AUDIT_VERIFIED" }),
  )

  assert.equal(evidence.assets.escrowComplete, true)
  assert.equal(evidence.assets.auditVerified, true)
  assert.equal(evidence.assets.publishedExact, false)
  assert.equal(evidence.audit.complete, true)
  assert.deepEqual(evidence.conflicts, [])
})

test("audit-result bytes must match the marker canonical digest", () => {
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED" })
  const canonical = observation.release.assets.find(({ name }) => name === "audit-result.json")
  assert.equal(canonical.sha256, AUDIT_SHA256)
  canonical.sha256 = "8".repeat(64)

  const evidence = correlateReleaseEvidence(candidate(), observation)
  assert.equal(evidence.assets.auditVerified, false)
  assert.equal(evidence.conflicts.includes("github-audit-result-bytes-mismatch"), true)
})

test("abandonment retains the exact verified base without classifying escrow complete", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({ phase: "ABANDONED_PREPUBLICATION" }),
  )

  assert.equal(evidence.assets.markerPhase, "ABANDONED_PREPUBLICATION")
  assert.equal(evidence.assets.escrowComplete, false)
  assert.equal(evidence.assets.draftExact, false)
  assert.deepEqual(evidence.conflicts, [])
})

test("shared non-npm evidence keeps every positive release gate independent of missing npm signature", async () => {
  const { correlateNonNpmReleaseEvidence } = await import("../evidence.mjs")
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })
  observation.registry.packages[0].signature.status = "missing"

  const evidence = correlateNonNpmReleaseEvidence(candidate(), observation)

  assert.deepEqual(evidence.conflicts, [])
  assert.equal(evidence.artifact.attested, true)
  assert.equal(evidence.assets.publishedExact, true)
  assert.equal(evidence.smokes.complete, true)
  assert.equal(evidence.audit.complete, true)
  assert.equal(Object.hasOwn(evidence, "npm"), false)
  assert.ok(
    correlateReleaseEvidence(candidate(), observation).conflicts.includes("npm-signature-missing"),
  )
})

test("shared non-npm policy retains identity, CI, inventory, and arbitration gates", async () => {
  const { correlateNonNpmReleaseEvidence } = await import("../evidence.mjs")
  const { findNonNpmPolicyConflicts } = await import("../conflicts.mjs")
  const { RELEASE_PROGRESS_RANK } = await import("../state.mjs")
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })
  observation.ci.status = "failed"
  observation.otherCandidates = [
    { version: "0.8.21", commitSha: "1".repeat(40), state: "CANDIDATE_TAGGED" },
  ]

  const conflicts = findNonNpmPolicyConflicts(
    candidate(),
    observation,
    correlateNonNpmReleaseEvidence(candidate(), observation),
    "AUDIT_COMPLETE",
    RELEASE_PROGRESS_RANK,
  )

  assert.ok(conflicts.includes("candidate-ci-failed"))
  assert.ok(conflicts.includes("older-tagged-candidate-incomplete"))
})
