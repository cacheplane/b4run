import { createHash } from "node:crypto"
import { snapshotJson } from "./adapter-normalize.mjs"
import { manifestSha256, validateSealedReleaseManifest } from "./manifest.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "./npm-evidence.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

/** The only historical publication this policy can admit. */
export const HISTORICAL_0155_INCIDENT = Object.freeze({
  repository: "cacheplane/b4run",
  repositoryId: 1210070282,
  version: "0.15.5",
  commitSha: "877ce4899406cebabc150e80309cb5dbf2299bee",
  tag: "v0.15.5",
  tagObjectSha: "124be1a3f847cd19aa049ffd678e9a5df1343a63",
  releaseId: 424591222,
  manifestSha256: "81b7df4408a73b1e236570cace34efbfdd9cea5848dc2f8145cd6d730c29429e",
  publisherRunId: 40370125207,
  publisherRunAttempt: 1,
  publisherWorkflow: ".github/workflows/release.yml",
  publisherRef: "refs/tags/v0.15.5",
  artifactId: 12675176514,
  artifactName: "npm-evidence-40370125207-1",
  archiveServiceDigest: "sha256:0f51da9687083ee0dddfbac37139732253409f23832457d2a8ea8119f129a29d",
  originalReceiptSha256: "1401b7303458f1a9f31f325711b3275a5b765e0baaee4ab7d6c285d646cc4d1e",
  auditRunId: 40376822663,
  auditRunAttempt: 1,
  auditWorkflow: ".github/workflows/published-artifact-verify.yml",
  exceptionalPackage: "create-b4-app",
  missingProof: "npm-keyed-publish-attestation",
  resumeVersion: "0.15.7",
  resumeCommitSha: "e67a92e4dc3b0f5ffc884ecee3fa8d87d5d788c4",
  resumeTag: "v0.15.7",
  resumeTagObjectSha: "46c8f5322cc2fdba38d1c40c5c2b1415541e2527",
})

/** Revision of the explicitly reviewed historical assertion policy. */
export const HISTORICAL_PUBLICATION_POLICY_REVISION = "historical-0155-v1"
/** The record location is code owned and cannot be overridden by callers. */
export const HISTORICAL_PUBLICATION_RECORD_PATH =
  "scripts/release/historical-publications/v0.15.5.json"
/** Maximum canonical record size, including the original complete receipt. */
export const HISTORICAL_PUBLICATION_RECORD_MAX_BYTES = 2 * 1024 * 1024
/** Exact object fields shared with the read-only collector. */
export const HISTORICAL_PUBLICATION_FIELDS = freeze({
  record: [
    "schemaVersion",
    "policyRevision",
    "incident",
    "capture",
    "original",
    "brackets",
    "sweeps",
    "supportingEvidence",
  ],
  capture: ["operator", "controllerSha", "startedAt", "finishedAt"],
  run: [
    "repository",
    "repositoryId",
    "runId",
    "runAttempt",
    "workflow",
    "ref",
    "commitSha",
    "status",
    "conclusion",
    "jobs",
  ],
  job: ["id", "name", "status", "conclusion"],
  artifact: ["id", "name", "runId", "serviceDigest", "size", "sha256", "path"],
  auditAsset: ["id", "name", "size", "sha256", "receipt"],
  bracket: ["observedAt", "factsSha256", "releaseOwnersInactive"],
  sweep: ["startedAt", "finishedAt", "evidenceSha256", "packages"],
  package: [
    "name",
    "version",
    "filename",
    "size",
    "sha256",
    "sha512",
    "npmIntegrity",
    "access",
    "verification",
  ],
  support: ["path", "size", "sha256"],
})
const SHA = /^[a-f0-9]{40}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const CANDIDATE = Object.freeze({
  version: HISTORICAL_0155_INCIDENT.version,
  commitSha: HISTORICAL_0155_INCIDENT.commitSha,
  publisherWorkflow: HISTORICAL_0155_INCIDENT.publisherWorkflow,
})
const PARSED_RECORDS = new WeakSet()
const MAX_CAPTURE_MS = 15 * 60 * 1000
const MAX_SUPPORT_BYTES = 64 * 1024 * 1024
const EVIDENCE_PREFIX = "scripts/release/historical-publications/evidence/v0.15.5/"

/** Parse an incident-bound record against its actual sealed manifest; no authority is inferred from a digest alone. */
export function parseHistoricalPublicationRecord(raw, { manifest } = {}) {
  let sourceBytes
  let value
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    sourceBytes = Buffer.from(raw)
    bound(sourceBytes.length, HISTORICAL_PUBLICATION_RECORD_MAX_BYTES, "record bytes")
    value = snapshotJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes)))
  } else {
    value = snapshotJson(raw)
  }
  // Parsed results carry the digest out of band; accepting that exact result for revalidation
  // never permits callers to assert a different digest or add a schema field to raw JSON.
  if (sourceBytes === undefined && PARSED_RECORDS.has(raw)) {
    const { sha256: claimed, ...record } = value
    if (!DIGEST.test(claimed) || digest(canonical(record)) !== claimed) fail("record digest")
    value = record
  }
  exact(value, HISTORICAL_PUBLICATION_FIELDS.record, "record")
  if (value.schemaVersion !== 1 || value.policyRevision !== HISTORICAL_PUBLICATION_POLICY_REVISION)
    fail("policy revision")
  exact(value.incident, Object.keys(HISTORICAL_0155_INCIDENT), "incident")
  for (const [key, expected] of Object.entries(HISTORICAL_0155_INCIDENT))
    if (value.incident[key] !== expected) fail(`incident ${key}`)
  const sealed = validateSealedReleaseManifest(snapshotJson(manifest), {
    candidate: CANDIDATE,
  })
  if (manifestSha256(sealed) !== HISTORICAL_0155_INCIDENT.manifestSha256)
    fail("sealed manifest digest")
  validateCapture(value.capture)
  exact(value.original, ["publisher", "artifact", "npmEvidence", "audit"], "original evidence")
  validateRun(
    value.original.publisher,
    HISTORICAL_0155_INCIDENT.publisherRunId,
    HISTORICAL_0155_INCIDENT.publisherWorkflow,
    "publish-npm",
  )
  const artifact = value.original.artifact
  exact(artifact, HISTORICAL_PUBLICATION_FIELDS.artifact, "original artifact")
  if (
    artifact.id !== HISTORICAL_0155_INCIDENT.artifactId ||
    artifact.name !== HISTORICAL_0155_INCIDENT.artifactName ||
    artifact.runId !== HISTORICAL_0155_INCIDENT.publisherRunId ||
    artifact.serviceDigest !== HISTORICAL_0155_INCIDENT.archiveServiceDigest ||
    artifact.sha256 !== artifact.serviceDigest.slice(7)
  )
    fail("original artifact binding")
  bound(artifact.size, MAX_SUPPORT_BYTES, "original archive size")
  evidencePath(artifact.path)
  const context = {
    candidate: CANDIDATE,
    manifest: sealed,
    manifestSha256: HISTORICAL_0155_INCIDENT.manifestSha256,
  }
  const receipt = parseNpmEvidence(value.original.npmEvidence, context)
  const receiptBytes = canonicalNpmEvidenceBytes(receipt, context)
  if (digest(receiptBytes) !== HISTORICAL_0155_INCIDENT.originalReceiptSha256)
    fail("original receipt digest")
  validateAudit(value.original.audit)
  validateSupport(value.supportingEvidence)
  requireSupport(value.supportingEvidence, artifact.sha256, artifact.size, artifact.path)
  requireSupport(
    value.supportingEvidence,
    HISTORICAL_0155_INCIDENT.originalReceiptSha256,
    receiptBytes.length,
    `${EVIDENCE_PREFIX}npm-evidence.json`,
  )
  for (const asset of value.original.audit.receipts)
    requireSupport(
      value.supportingEvidence,
      asset.sha256,
      asset.size,
      `${EVIDENCE_PREFIX}${asset.name}`,
    )
  validateObservations(value, sealed)
  const bytes = canonical(value)
  bound(bytes.length, HISTORICAL_PUBLICATION_RECORD_MAX_BYTES, "canonical record bytes")
  if (sourceBytes !== undefined && !sourceBytes.equals(bytes)) fail("noncanonical record bytes")
  const parsed = freeze({ ...value, sha256: digest(bytes) })
  PARSED_RECORDS.add(parsed)
  return parsed
}

/** Encode a validated record as sorted, newline-terminated canonical JSON. */
export function canonicalHistoricalPublicationRecordBytes(value, context) {
  const { sha256: _sha256, ...record } = parseHistoricalPublicationRecord(value, context)
  return canonical(record)
}

/** Read only the incident's regular canonical blob at an immutable trusted controller commit. */
export async function readHistoricalPublicationRecord({ git, ref, manifest }) {
  if (
    typeof git?.listTreeEntries !== "function" ||
    typeof git?.showFile !== "function" ||
    !SHA.test(ref)
  )
    fail("trusted Git reader")
  const listing = await git.listTreeEntries({ ref })
  if (
    typeof listing !== "string" ||
    (listing.length > 0 && !listing.endsWith("\0")) ||
    Buffer.byteLength(listing) > 16 * 1024 * 1024
  )
    fail("Git tree listing")
  const rows = listing.length === 0 ? [] : listing.slice(0, -1).split("\0")
  const paths = new Set()
  let found = false
  for (const row of rows) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row)
    if (!match || paths.has(match[4])) fail("Git tree entry")
    paths.add(match[4])
    if (match[4] === HISTORICAL_PUBLICATION_RECORD_PATH) {
      if (match[1] !== "100644" || match[2] !== "blob") fail("record regular mode")
      found = true
    }
  }
  if (!found) return null
  const bytes = await git.showFile({
    ref,
    path: HISTORICAL_PUBLICATION_RECORD_PATH,
  })
  if (typeof bytes !== "string") fail("record Git contents")
  return parseHistoricalPublicationRecord(bytes, { manifest })
}

function validateCapture(capture) {
  exact(capture, HISTORICAL_PUBLICATION_FIELDS.capture, "capture")
  exact(capture.operator, ["login", "id"], "operator")
  if (
    !text(capture.operator.login, 256) ||
    !positive(capture.operator.id) ||
    !SHA.test(capture.controllerSha)
  )
    fail("capture identity")
  const start = time(capture.startedAt),
    end = time(capture.finishedAt)
  if (end < start || end - start > MAX_CAPTURE_MS) fail("capture interval")
}
function validateRun(run, runId, workflow, jobName) {
  exact(run, HISTORICAL_PUBLICATION_FIELDS.run, "original run")
  if (
    run.repository !== HISTORICAL_0155_INCIDENT.repository ||
    run.repositoryId !== HISTORICAL_0155_INCIDENT.repositoryId ||
    run.runId !== runId ||
    run.runAttempt !== 1 ||
    run.workflow !== workflow ||
    run.ref !== HISTORICAL_0155_INCIDENT.publisherRef ||
    run.commitSha !== CANDIDATE.commitSha ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Array.isArray(run.jobs) ||
    run.jobs.length < 1 ||
    run.jobs.length > 256
  )
    fail("original run identity")
  const ids = new Set(),
    names = new Set()
  for (const job of run.jobs) {
    exact(job, HISTORICAL_PUBLICATION_FIELDS.job, "original job")
    if (
      !positive(job.id) ||
      ids.has(job.id) ||
      !text(job.name, 256) ||
      names.has(job.name) ||
      job.status !== "completed" ||
      !["success", "skipped"].includes(job.conclusion)
    )
      fail("original job inventory")
    ids.add(job.id)
    names.add(job.name)
  }
  if (run.jobs.filter((job) => job.name === jobName && job.conclusion === "success").length !== 1)
    fail("original producing job")
}
function validateAudit(audit) {
  exact(audit, ["run", "receipts"], "original audit")
  validateRun(
    audit.run,
    HISTORICAL_0155_INCIDENT.auditRunId,
    HISTORICAL_0155_INCIDENT.auditWorkflow,
    "verify",
  )
  if (!Array.isArray(audit.receipts) || audit.receipts.length !== 2) fail("audit receipt assets")
  const names = ["audit-result.json", `audit-attempt-${HISTORICAL_0155_INCIDENT.auditRunId}-1.json`]
  const ids = new Set()
  let previousDigest
  for (let index = 0; index < 2; index++) {
    const asset = audit.receipts[index]
    exact(asset, HISTORICAL_PUBLICATION_FIELDS.auditAsset, "audit receipt asset")
    const receipt = parseAuditResult(asset.receipt)
    const bytes = canonicalAuditResultBytes(receipt)
    if (
      !positive(asset.id) ||
      ids.has(asset.id) ||
      asset.name !== names[index] ||
      asset.size !== bytes.length ||
      asset.sha256 !== digest(bytes) ||
      (previousDigest !== undefined && previousDigest !== asset.sha256) ||
      receipt.conclusion !== "success" ||
      receipt.version !== CANDIDATE.version ||
      receipt.commitSha !== CANDIDATE.commitSha ||
      receipt.manifestSha256 !== HISTORICAL_0155_INCIDENT.manifestSha256 ||
      receipt.workflowRunId !== HISTORICAL_0155_INCIDENT.auditRunId ||
      receipt.runAttempt !== 1
    )
      fail("audit receipt binding")
    ids.add(asset.id)
    previousDigest = asset.sha256
  }
}
function validateSupport(files) {
  if (!Array.isArray(files) || files.length < 6 || files.length > 128)
    fail("supporting evidence inventory")
  let previous = ""
  for (const file of files) {
    exact(file, HISTORICAL_PUBLICATION_FIELDS.support, "supporting evidence file")
    evidencePath(file.path)
    if (file.path <= previous || !DIGEST.test(file.sha256)) fail("supporting evidence identity")
    bound(file.size, MAX_SUPPORT_BYTES, "supporting evidence size")
    previous = file.path
  }
}
function requireSupport(files, sha256, size, path) {
  if (
    !files.some(
      (file) =>
        file.sha256 === sha256 &&
        (size === undefined || file.size === size) &&
        (path === undefined || file.path === path),
    )
  )
    fail("retained supporting evidence binding")
}
function validateObservations(record, manifest) {
  if (
    !Array.isArray(record.brackets) ||
    record.brackets.length !== 2 ||
    !Array.isArray(record.sweeps) ||
    record.sweeps.length !== 2
  )
    fail("two bracketed sweeps")
  for (const bracket of record.brackets) {
    exact(bracket, HISTORICAL_PUBLICATION_FIELDS.bracket, "bracket")
    time(bracket.observedAt)
    if (bracket.releaseOwnersInactive !== true || !DIGEST.test(bracket.factsSha256))
      fail("bracket facts")
    requireSupport(record.supportingEvidence, bracket.factsSha256)
  }
  if (record.brackets[0].factsSha256 !== record.brackets[1].factsSha256)
    fail("bracket identity drift")
  for (const sweep of record.sweeps) {
    exact(sweep, HISTORICAL_PUBLICATION_FIELDS.sweep, "sweep")
    if (
      time(sweep.finishedAt) < time(sweep.startedAt) ||
      !DIGEST.test(sweep.evidenceSha256) ||
      !Array.isArray(sweep.packages) ||
      sweep.packages.length !== 21
    )
      fail("sweep identity")
    requireSupport(record.supportingEvidence, sweep.evidenceSha256)
    for (let index = 0; index < 21; index++) {
      const row = sweep.packages[index],
        entry = manifest.packages[index]
      exact(row, HISTORICAL_PUBLICATION_FIELDS.package, "sweep package")
      for (const [key, value] of Object.entries(entry))
        if (row[key] !== value) fail("sweep manifest binding")
      if (
        row.verification !==
        (entry.name === HISTORICAL_0155_INCIDENT.exceptionalPackage
          ? "historical-provenance"
          : "complete")
      )
        fail("sweep verification shape")
    }
  }
  const first = record.sweeps[0],
    second = record.sweeps[1]
  if (
    time(record.capture.startedAt) > time(record.brackets[0].observedAt) ||
    time(record.brackets[0].observedAt) > time(first.startedAt) ||
    time(first.finishedAt) > time(second.startedAt) ||
    time(second.startedAt) - time(first.startedAt) < 60_000 ||
    time(second.finishedAt) > time(record.brackets[1].observedAt) ||
    time(record.brackets[1].observedAt) > time(record.capture.finishedAt)
  )
    fail("capture observation ordering")
}
function evidencePath(path) {
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !path.startsWith(EVIDENCE_PREFIX) ||
    !/^[A-Za-z0-9./_-]+$/u.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail("retained evidence path")
}
function exact(value, fields, label) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    fail(`${label} fields`)
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0
}
function bound(value, max, label) {
  if (!positive(value) || value > max) fail(label)
}
function text(value, max) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= max &&
    ![...value].some(
      (character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127,
    )
  )
}
function time(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("timestamp")
  return Date.parse(value)
}
function canonical(value) {
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`)
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
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function fail(label) {
  throw new TypeError(`Invalid historical publication ${label}`)
}
