import { createHash } from "node:crypto"
import { normalizeAdapterEnvelope, snapshotJson } from "./adapter-normalize.mjs"
import { extractActionsArtifactZip } from "./artifact-store.mjs"
import { findNonNpmPolicyConflicts } from "./conflicts.mjs"
import { correlateNonNpmReleaseEvidence } from "./evidence.mjs"
import {
  HISTORICAL_0155_INCIDENT,
  HISTORICAL_PUBLICATION_POLICY_REVISION,
  parseHistoricalPublicationRecord,
} from "./historical-publication-record.mjs"
import { NPM_AUDIT_VERIFIER } from "./npm-audit.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "./npm-evidence.mjs"
import { parseRecovery } from "./recovery/schema.mjs"
import { compareSemver, isExactSemver } from "./semver.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "./smoke-result.mjs"
import { canonicalAuditResultBytes } from "./terminal-records.mjs"

const INCIDENT = HISTORICAL_0155_INCIDENT
const PREFIX = "scripts/release/historical-publications/evidence/v0.15.5/"
/** Code-owned captured artifact metadata, used only after its authenticated expiry. */
export const HISTORICAL_ARTIFACT_METADATA_PATH = `${PREFIX}original-artifact.json`

/** Authenticate the bounded original archive and canonical original receipt against the sealed manifest. */
export function authenticateOriginalNpmArchive(raw, { record, manifest }) {
  const admitted = parseHistoricalPublicationRecord(record, { manifest })
  if (!(raw instanceof Uint8Array)) fail("archive bytes")
  const bytes = Buffer.from(raw)
  if (
    bytes.length !== admitted.original.artifact.size ||
    digest(bytes) !== admitted.original.artifact.sha256
  )
    fail("archive digest or size")
  const files = extractActionsArtifactZip(bytes, { maxOutputBytes: 2 * 1024 * 1024 })
  if (files.length !== 1 || files[0].name !== "npm-evidence.json") fail("archive exact contents")
  const context = { candidate: INCIDENT, manifest, manifestSha256: INCIDENT.manifestSha256 }
  const npmEvidence = parseNpmEvidence(files[0].bytes, context)
  const receiptBytes = canonicalNpmEvidenceBytes(npmEvidence, context)
  if (
    !Buffer.from(files[0].bytes).equals(receiptBytes) ||
    digest(receiptBytes) !== INCIDENT.originalReceiptSha256
  )
    fail("original receipt canonical digest")
  return Object.freeze({
    npmEvidence,
    archiveSha256: digest(bytes),
    receiptSha256: digest(receiptBytes),
  })
}

/** Authenticate retained original evidence and freshly bracket the original mutable run and job metadata. */
export async function authenticateHistoricalOriginalEvidence({
  record,
  manifest,
  git,
  ref,
  github,
  now = Date.now(),
}) {
  const admitted = parseHistoricalPublicationRecord(record, { manifest })
  if (!Number.isSafeInteger(now) || now < 0) fail("observation clock")
  const files = await readHistoricalSupportingEvidence({ record: admitted, manifest, git, ref })
  const archive = authenticateOriginalNpmArchive(files.get(admitted.original.artifact.path), {
    record: admitted,
    manifest,
  })
  const receipt = canonicalNpmEvidenceBytes(archive.npmEvidence, {
    candidate: INCIDENT,
    manifest,
    manifestSha256: INCIDENT.manifestSha256,
  })
  if (!files.get(`${PREFIX}npm-evidence.json`)?.equals(receipt)) fail("retained receipt bytes")
  const tagRef = await readPresent(github.getRef({ ref: `tags/${INCIDENT.tag}` }), "ref")
  if (
    tagRef.ref !== INCIDENT.publisherRef ||
    tagRef.object?.type !== "tag" ||
    tagRef.object.sha !== INCIDENT.tagObjectSha
  )
    fail("historical tag object")
  const tag = await readPresent(github.getGitTag({ tagSha: INCIDENT.tagObjectSha }), "git-tag")
  if (
    tag.sha !== INCIDENT.tagObjectSha ||
    tag.tag !== INCIDENT.tag ||
    tag.object?.type !== "commit" ||
    tag.object.sha !== INCIDENT.commitSha
  )
    fail("historical tag peel")
  const ownership = await authenticateHistoricalOwnership({ git, ref })
  const publisher = await authenticateHistoricalRun({
    github,
    expected: admitted.original.publisher,
  })
  const auditRun = await authenticateHistoricalRun({
    github,
    expected: admitted.original.audit.run,
  })
  const captured = parseCapturedArtifactMetadata(
    files.get(HISTORICAL_ARTIFACT_METADATA_PATH),
    admitted,
  )
  await authenticateLiveOriginalArtifact({ github, record: admitted, captured, now })
  const release = await readPresent(github.getRelease({ releaseId: INCIDENT.releaseId }), "release")
  if (
    release.id !== INCIDENT.releaseId ||
    release.tag_name !== INCIDENT.tag ||
    release.immutable !== true ||
    release.draft !== false
  )
    fail("immutable release identity")
  const assets = await readPresent(
    github.listReleaseAssets({ releaseId: INCIDENT.releaseId }),
    "release-assets",
  )
  if (
    !Array.isArray(assets) ||
    assets.length > 1024 ||
    new Set(assets.map((asset) => asset.id)).size !== assets.length
  )
    fail("audit asset inventory")
  for (const expected of admitted.original.audit.receipts) {
    const matches = assets.filter(
      (asset) => asset.name === expected.name || asset.id === expected.id,
    )
    if (matches.length !== 1) fail("audit asset unique identity")
    const asset = matches[0]
    if (
      asset.id !== expected.id ||
      asset.name !== expected.name ||
      asset.size !== expected.size ||
      asset.digest !== `sha256:${expected.sha256}`
    )
      fail("audit asset metadata")
    const bytes = await readBinary(
      github.downloadReleaseAsset({ assetId: asset.id }),
      "release-asset-download",
      expected.size,
    )
    if (
      digest(bytes) !== expected.sha256 ||
      !bytes.equals(canonicalAuditResultBytes(expected.receipt)) ||
      !bytes.equals(files.get(`${PREFIX}${asset.name}`))
    )
      fail("audit canonical receipt bytes")
  }
  return freeze({
    publisher,
    audit: { run: auditRun, receipts: admitted.original.audit.receipts },
    artifact: admitted.original.artifact,
    archiveSha256: archive.archiveSha256,
    receiptSha256: archive.receiptSha256,
    ownership,
    signatureAssertionSource: "authenticated-original-npm-receipt",
    tag: { name: INCIDENT.tag, objectSha: INCIDENT.tagObjectSha, commitSha: INCIDENT.commitSha },
    releaseId: INCIDENT.releaseId,
  })
}

/** Read exact digest-bound regular supporting blobs only from an immutable controller commit. */
export async function readHistoricalSupportingEvidence({ record, manifest, git, ref }) {
  const admitted = parseHistoricalPublicationRecord(record, { manifest })
  if (!/^[a-f0-9]{40}$/u.test(ref) || typeof git?.showFileBytes !== "function")
    fail("trusted support reader")
  const listing = await git.listTreeEntries({ ref })
  if (
    typeof listing !== "string" ||
    !listing.endsWith("\0") ||
    Buffer.byteLength(listing) > 16 * 1024 * 1024
  )
    fail("support tree inventory")
  const entries = new Map()
  for (const row of listing.slice(0, -1).split("\0")) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row)
    if (!match || entries.has(match[4])) fail("support tree entry")
    entries.set(match[4], match)
  }
  if (admitted.supportingEvidence.reduce((size, file) => size + file.size, 0) > 128 * 1024 * 1024)
    fail("support total bytes")
  const result = new Map()
  for (const file of admitted.supportingEvidence) {
    const entry = entries.get(file.path)
    if (entry?.[1] !== "100644" || entry[2] !== "blob") fail("support regular file")
    const bytes = await git.showFileBytes({ ref, path: file.path })
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || digest(bytes) !== file.sha256)
      fail("support digest or size")
    result.set(file.path, Buffer.from(bytes))
  }
  return result
}

/** Freshly verify an exact run, attempt, repository, workflow and complete source-bound job inventory. */
export async function authenticateHistoricalRun({ github, expected }) {
  const validate = (run) => {
    if (
      run?.id !== expected.runId ||
      run.run_attempt !== expected.runAttempt ||
      run.repository?.id !== expected.repositoryId ||
      run.repository.full_name !== expected.repository ||
      run.path !== expected.workflow ||
      `refs/tags/${run.head_branch}` !== expected.ref ||
      run.head_sha !== expected.commitSha ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    )
      fail("fresh run identity")
  }
  validate(await readPresent(github.getActionsRun({ runId: expected.runId }), "actions-run"))
  validate(
    await readPresent(
      github.getActionsRunAttempt({ runId: expected.runId, attempt: expected.runAttempt }),
      "actions-run-attempt",
    ),
  )
  const jobs = await readPresent(
    github.listActionsRunJobsComplete({ runId: expected.runId }),
    "actions-run-jobs-complete",
  )
  if (
    !Array.isArray(jobs) ||
    jobs.length !== expected.jobs.length ||
    jobs.length < 1 ||
    jobs.length > 256
  )
    fail("fresh complete jobs")
  const ids = new Set(),
    names = new Set()
  for (const job of jobs) {
    const original = expected.jobs.find((value) => value.id === job.id)
    if (
      !original ||
      ids.has(job.id) ||
      names.has(job.name) ||
      job.runAttempt !== expected.runAttempt ||
      job.run_id !== expected.runId ||
      job.head_sha !== expected.commitSha ||
      job.name !== original.name ||
      job.status !== original.status ||
      job.conclusion !== original.conclusion ||
      !validServiceTime(job.startedAt) ||
      !validServiceTime(job.completedAt) ||
      Date.parse(job.completedAt) < Date.parse(job.startedAt)
    )
      fail("fresh job source or identity")
    ids.add(job.id)
    names.add(job.name)
  }
  validate(await readPresent(github.getActionsRun({ runId: expected.runId }), "actions-run"))
  return expected
}

const COMPLETION_FIELDS = [
  "kind",
  "policyRevision",
  "incident",
  "record",
  "recordSha256",
  "manifest",
  "original",
  "packages",
  "obligations",
]
const OBLIGATION_FIELDS = [
  "inventory",
  "ci",
  "otherCandidates",
  "tag",
  "artifacts",
  "escrow",
  "release",
  "requiredSmokeLanes",
  "smokes",
  "audit",
  "abandonment",
  "smokeAdjudication",
]
/** Compose typed positive assertions from this observation, preserving original and fresh authority separately. */
export function createHistoricalCompletion({
  candidate,
  observation,
  record,
  manifest,
  original,
  packages,
  progressRank,
}) {
  const admitted = parseHistoricalPublicationRecord(record, { manifest })
  const { sha256: recordSha256, ...sourceRecord } = admitted
  if (!Array.isArray(packages) || packages.length !== manifest.packages.length)
    fail("fresh package inventory")
  const orderedPackages = manifest.packages.map((entry) => {
    const matches = packages.filter((row) => row?.entry?.name === entry.name)
    if (matches.length !== 1) fail("fresh unique package inventory")
    return matches[0]
  })
  const proof = snapshotJson({
    kind: "historical-completion",
    policyRevision: HISTORICAL_PUBLICATION_POLICY_REVISION,
    incident: INCIDENT,
    record: sourceRecord,
    recordSha256,
    manifest,
    original,
    packages: orderedPackages,
    obligations: obligationBindings(observation),
  })
  const conflicts = findHistoricalCompletionConflicts(
    candidate,
    { ...observation, historicalCompletion: proof },
    progressRank,
  )
  if (conflicts.length > 0) fail(`positive obligations (${conflicts.join(", ")})`)
  return freeze(proof)
}

/** Independently validate every historical assertion and shared positive gate; this grants terminal observation only. */
export function findHistoricalCompletionConflicts(candidate, observation, progressRank) {
  const conflicts = new Set()
  const shared = correlateNonNpmReleaseEvidence(candidate, observation)
  if (!shared.structureValid)
    return Object.freeze(
      [...new Set([...shared.conflicts, "historical-completion-invalid"])].sort(),
    )
  for (const conflict of findNonNpmPolicyConflicts(
    candidate,
    observation,
    shared,
    "AUDIT_COMPLETE",
    progressRank,
  ))
    conflicts.add(conflict)
  if (
    !shared.structureValid ||
    !shared.schemaValid ||
    !shared.artifact.attested ||
    !shared.assets.publishedExact ||
    !shared.assets.escrowComplete ||
    !shared.smokes.complete ||
    shared.smokes.adjudicated ||
    !shared.audit.complete
  )
    conflicts.add("historical-positive-obligations-incomplete")
  try {
    const proof = snapshotJson(observation.historicalCompletion)
    exact(proof, COMPLETION_FIELDS)
    if (
      proof.kind !== "historical-completion" ||
      proof.policyRevision !== HISTORICAL_PUBLICATION_POLICY_REVISION ||
      !same(proof.incident, INCIDENT) ||
      candidate.version !== INCIDENT.version ||
      candidate.commitSha !== INCIDENT.commitSha ||
      candidate.publisherWorkflow !== INCIDENT.publisherWorkflow
    )
      fail("completion incident identity")
    const admitted = parseHistoricalPublicationRecord(proof.record, { manifest: proof.manifest })
    const ownership = proof.original?.ownership
    exact(ownership, ["controllerRef", "treeSha256", "adoptions"])
    if (
      !/^[a-f0-9]{40}$/u.test(ownership.controllerRef) ||
      !/^[a-f0-9]{64}$/u.test(ownership.treeSha256) ||
      !Array.isArray(ownership.adoptions) ||
      ownership.adoptions.length > 256
    )
      fail("ownership source")
    const ownershipPaths = new Set()
    for (const adoption of ownership.adoptions) {
      exact(adoption, ["path", "sha256", "version", "commitSha"])
      if (
        !/^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(
          adoption.path,
        ) ||
        ownershipPaths.has(adoption.path) ||
        !/^[a-f0-9]{64}$/u.test(adoption.sha256) ||
        !isExactSemver(adoption.version) ||
        !/^[a-f0-9]{40}$/u.test(adoption.commitSha) ||
        adoption.version === INCIDENT.version
      )
        fail("contradictory ownership source")
      ownershipPaths.add(adoption.path)
    }
    if (
      proof.recordSha256 !== admitted.sha256 ||
      !same(proof.original, originalAssertions(admitted, ownership))
    )
      fail("completion original source")
    exact(proof.obligations, OBLIGATION_FIELDS)
    if (!same(proof.obligations, obligationBindings(observation)))
      fail("completion obligation bindings")
    if (
      observation.release.status !== "published" ||
      observation.release.immutable !== true ||
      observation.release.marker?.npmEvidenceSha256 !== INCIDENT.originalReceiptSha256 ||
      observation.release.marker?.manifestSha256 !== INCIDENT.manifestSha256 ||
      observation.audit.workflowRunId !== INCIDENT.auditRunId ||
      observation.audit.runAttempt !== 1 ||
      observation.release.marker.audit?.workflowRunId !== INCIDENT.auditRunId ||
      observation.release.marker.audit?.runAttempt !== 1 ||
      observation.abandonment.requested ||
      observation.abandonment.recorded ||
      observation.smokeAdjudication != null ||
      !same(observation.requiredSmokeLanes, REQUIRED_RELEASE_SMOKE_LANES)
    )
      fail("published historical terminal obligations")
    if (
      observation.ci.workflowRunId !== proof.manifest.ci.runId ||
      observation.ci.runAttempt !== proof.manifest.ci.runAttempt ||
      observation.ci.workflow !== proof.manifest.ci.workflow
    )
      fail("sealed CI identity")
    if (
      observation.smokes.some(
        (smoke) =>
          smoke.status !== "passed" ||
          smoke.workflowRunId !== observation.release.marker.smoke?.workflowRunId ||
          smoke.runAttempt !== observation.release.marker.smoke?.runAttempt,
      )
    )
      fail("real selected smoke obligations")
    if (
      !Array.isArray(proof.packages) ||
      proof.packages.length !== 21 ||
      observation.inventory.packages.length !== 21 ||
      observation.registry.packages.length !== 21
    )
      fail("completion exact inventory")
    let historicalCount = 0
    for (let index = 0; index < proof.manifest.packages.length; index++) {
      const entry = proof.manifest.packages[index],
        row = proof.packages[index]
      exact(row, ["entry", "verification"])
      if (!same(row.entry, entry)) fail("completion manifest entry")
      const inventory = observation.inventory.packages.filter((pkg) => pkg.name === entry.name)
      const matches = observation.registry.packages.filter((pkg) => pkg.name === entry.name)
      if (inventory.length !== 1 || matches.length !== 1) fail("completion unique package")
      const pkg = matches[0]
      if (
        inventory[0].filename !== entry.filename ||
        inventory[0].tarballSha256 !== entry.sha256 ||
        inventory[0].integrity !== entry.npmIntegrity ||
        pkg.status !== "present" ||
        pkg.version !== entry.version ||
        pkg.tarballSha256 !== entry.sha256 ||
        pkg.integrity !== entry.npmIntegrity ||
        pkg.latest?.status !== "present" ||
        !isExactSemver(pkg.latest.version) ||
        compareSemver(pkg.latest.version, INCIDENT.version) < 0 ||
        pkg.provenance?.workflow !== INCIDENT.publisherWorkflow ||
        pkg.provenance?.commitSha !== INCIDENT.commitSha
      )
        fail("completion live package bytes or identity")
      const verification = row.verification
      if (verification.kind === "historical-provenance") {
        historicalCount++
        if (
          pkg.signature.status !== "missing" ||
          !isHistoricalNpmAuditEvidence(verification, {
            candidate,
            record: admitted,
            manifest: proof.manifest,
            entry,
          })
        )
          fail("remaining provenance authority")
      } else {
        exact(verification, ["status", "signature", "provenance"])
        exact(verification.signature, ["status", "verifier"])
        if (
          verification.status !== "verified" ||
          verification.signature.status !== "valid" ||
          verification.signature.verifier !== NPM_AUDIT_VERIFIER ||
          pkg.signature.status !== "valid"
        )
          fail("full official package authority")
      }
      exact(verification.provenance, [
        "predicateType",
        "workflow",
        "commitSha",
        "repository",
        "ref",
      ])
      if (
        !same(verification.provenance, {
          predicateType: "https://slsa.dev/provenance/v1",
          workflow: INCIDENT.publisherWorkflow,
          commitSha: INCIDENT.commitSha,
          repository: "https://github.com/cacheplane/b4run",
          ref: INCIDENT.publisherRef,
        })
      )
        fail("fresh provenance identity")
    }
    if (historicalCount !== 1) fail("historical proof incompatible with ordinary complete receipt")
  } catch {
    conflicts.add("historical-completion-invalid")
  }
  return Object.freeze([...conflicts].sort())
}

/** Accept only the incident's distinct fresh remaining-provenance assertion, never a fresh signature. */
export function isHistoricalNpmAuditEvidence(value, { candidate, record, manifest, entry }) {
  try {
    const proof = snapshotJson(value)
    const admitted = parseHistoricalPublicationRecord(record, { manifest })
    exact(proof, [
      "kind",
      "policyRevision",
      "recordSha256",
      "originalReceiptSha256",
      "officialOutputSha256",
      "provenanceBundleSha256",
      "keyedPublish",
      "provenance",
      "verifier",
    ])
    exact(proof.keyedPublish, ["status"])
    exact(proof.provenance, ["predicateType", "workflow", "commitSha", "repository", "ref"])
    return (
      candidate.version === INCIDENT.version &&
      candidate.commitSha === INCIDENT.commitSha &&
      candidate.publisherWorkflow === INCIDENT.publisherWorkflow &&
      same(
        entry,
        manifest.packages.find((entry) => entry.name === INCIDENT.exceptionalPackage),
      ) &&
      proof.kind === "historical-provenance" &&
      proof.policyRevision === admitted.policyRevision &&
      proof.recordSha256 === admitted.sha256 &&
      proof.originalReceiptSha256 === INCIDENT.originalReceiptSha256 &&
      /^[a-f0-9]{64}$/u.test(proof.officialOutputSha256) &&
      /^[a-f0-9]{64}$/u.test(proof.provenanceBundleSha256) &&
      proof.keyedPublish.status === "unavailable" &&
      proof.verifier === NPM_AUDIT_VERIFIER &&
      same(proof.provenance, {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: INCIDENT.publisherWorkflow,
        commitSha: INCIDENT.commitSha,
        repository: "https://github.com/cacheplane/b4run",
        ref: INCIDENT.publisherRef,
      })
    )
  } catch {
    return false
  }
}

function obligationBindings(observation) {
  return Object.fromEntries(
    OBLIGATION_FIELDS.map((key) => [
      key,
      digest(Buffer.from(JSON.stringify(observation[key] ?? null))),
    ]),
  )
}
function originalAssertions(record, ownership) {
  return {
    publisher: record.original.publisher,
    audit: record.original.audit,
    artifact: record.original.artifact,
    archiveSha256: record.original.artifact.sha256,
    receiptSha256: INCIDENT.originalReceiptSha256,
    ownership,
    signatureAssertionSource: "authenticated-original-npm-receipt",
    tag: { name: INCIDENT.tag, objectSha: INCIDENT.tagObjectSha, commitSha: INCIDENT.commitSha },
    releaseId: INCIDENT.releaseId,
  }
}
function same(left, right) {
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right))
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort(value[key])]),
  )
}

/** Bind historical ownership exclusions to the exact immutable controller tree and parsed adoption subjects. */
export async function authenticateHistoricalOwnership({ git, ref }) {
  if (!/^[a-f0-9]{40}$/u.test(ref)) fail("ownership immutable ref")
  const listing = await git.listTreeEntries({ ref })
  if (
    typeof listing !== "string" ||
    !listing.endsWith("\0") ||
    Buffer.byteLength(listing) > 16 * 1024 * 1024
  )
    fail("ownership complete tree")
  const paths = new Set(),
    adoptions = []
  for (const row of listing.slice(0, -1).split("\0")) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row)
    if (
      !match ||
      paths.has(match[4]) ||
      match[4].startsWith("/") ||
      [...match[4]].some(
        (character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127,
      ) ||
      match[4].split("/").some((part) => part === "" || part === "." || part === "..")
    )
      fail("ownership tree entry")
    const path = match[4]
    paths.add(path)
    if (!path.startsWith("scripts/release/recovery-adoptions/")) continue
    if (
      !/^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(path) ||
      match[1] !== "100644" ||
      match[2] !== "blob" ||
      adoptions.length >= 256
    )
      fail("ownership regular adoption inventory")
    const bytes = await git.showFileBytes({ ref, path })
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 2 * 1024 * 1024)
      fail("ownership adoption bytes")
    const intent = parseRecovery(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      kind: "recovery-adoption-intent",
    })
    if (intent.candidate.version === INCIDENT.version) fail("contradictory adoption reservation")
    adoptions.push({
      path,
      sha256: digest(bytes),
      version: intent.candidate.version,
      commitSha: intent.candidate.candidateSha,
    })
  }
  return freeze({ controllerRef: ref, treeSha256: digest(Buffer.from(listing)), adoptions })
}

function parseCapturedArtifactMetadata(bytes, record) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) fail("captured artifact metadata bytes")
  const value = snapshotJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  exact(value, [
    "id",
    "name",
    "runId",
    "headSha",
    "serviceDigest",
    "size",
    "expired",
    "expiresAt",
    "observedAt",
  ])
  const expected = record.original.artifact
  if (
    ["id", "name", "runId", "serviceDigest", "size"].some((key) => value[key] !== expected[key]) ||
    value.headSha !== INCIDENT.commitSha ||
    typeof value.expired !== "boolean" ||
    !validTime(value.expiresAt) ||
    !validTime(value.observedAt) ||
    Date.parse(value.observedAt) < Date.parse(record.capture.startedAt) ||
    Date.parse(value.observedAt) > Date.parse(record.capture.finishedAt) ||
    (value.expired && Date.parse(value.expiresAt) > Date.parse(value.observedAt))
  )
    fail("captured artifact metadata binding")
  return value
}

async function authenticateLiveOriginalArtifact({ github, record, captured, now }) {
  const expected = record.original.artifact
  const listing = await readPresent(
    github.listActionsRunArtifacts({ runId: expected.runId }),
    "actions-run-artifacts",
  )
  if (
    !Array.isArray(listing) ||
    listing.length > 1024 ||
    new Set(listing.map((artifact) => artifact.id)).size !== listing.length
  )
    fail("fresh artifact inventory")
  const matches = listing.filter(
    (artifact) => artifact.id === expected.id || artifact.name === expected.name,
  )
  if (matches.length > 1) fail("fresh artifact unique identity")
  const response = await github.getActionsArtifact({ artifactId: expected.id })
  const metadata = normalizeAdapterEnvelope(response, {
    source: "github",
    operation: "actions-artifact",
    payloadKey: "value",
  })
  const expired = Date.parse(captured.expiresAt) <= now
  if (metadata.status !== "PRESENT") {
    if (!expired || matches.length !== 0 || !isExpiredAbsence(response, "actions-artifact"))
      fail("fresh artifact unavailable before proven expiry")
    return
  }
  const valid = (artifact) => {
    if (
      artifact?.id !== expected.id ||
      artifact.name !== expected.name ||
      artifact.digest !== expected.serviceDigest ||
      artifact.size_in_bytes !== expected.size ||
      typeof artifact.expired !== "boolean" ||
      artifact.workflow_run?.id !== expected.runId ||
      artifact.workflow_run.head_sha !== INCIDENT.commitSha
    )
      fail("fresh original artifact binding")
  }
  valid(metadata.value)
  if (matches.length === 0) {
    if (!(expired && metadata.value.expired === true)) fail("fresh artifact run association")
  } else {
    valid(matches[0])
    if (matches[0].expired !== metadata.value.expired) fail("fresh artifact metadata drift")
  }
  const responseBytes = await github.downloadActionsArtifact({
    artifactId: expected.id,
    maximumBytes: expected.size,
  })
  if (responseBytes?.status !== "PRESENT") {
    if (
      !(
        expired &&
        metadata.value.expired === true &&
        isExpiredAbsence(responseBytes, "actions-artifact-download")
      )
    )
      fail("fresh original archive unavailable")
    return
  }
  const bytes = await readBinary(
    Promise.resolve(responseBytes),
    "actions-artifact-download",
    expected.size,
  )
  if (digest(bytes) !== expected.sha256) fail("fresh original archive digest")
}
function isExpiredAbsence(value, operation) {
  const result = normalizeAdapterEnvelope(value, {
    source: "github",
    operation,
    payloadKey: "value",
  })
  return (
    result.status === "AMBIGUOUS" &&
    ((result.httpStatus === 404 && result.code === "NOT_FOUND_OR_HIDDEN") ||
      (result.httpStatus === 410 && result.code === "HTTP_410"))
  )
}

async function readPresent(work, operation) {
  const result = normalizeAdapterEnvelope(await work, {
    source: "github",
    operation,
    payloadKey: "value",
  })
  if (result.status !== "PRESENT") fail(`fresh ${operation}`)
  return result.value
}
async function readBinary(work, operation, size) {
  const result = normalizeAdapterEnvelope(await work, {
    source: "github",
    operation,
    payloadKey: "contentBase64",
  })
  if (
    result.status !== "PRESENT" ||
    typeof result.contentBase64 !== "string" ||
    result.contentBase64.length > Math.ceil(size / 3) * 4
  )
    fail(`fresh ${operation} bytes`)
  const bytes = Buffer.from(result.contentBase64, "base64")
  if (bytes.length !== size || bytes.toString("base64") !== result.contentBase64)
    fail(`fresh ${operation} size`)
  return bytes
}
function exact(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    fail("exact fields")
}
function validServiceTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    validTime(value.includes(".") ? value : value.replace("Z", ".000Z"))
  )
}
function validTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function fail(label) {
  throw new TypeError(`Historical publication ${label} is invalid`)
}
