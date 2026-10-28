#!/usr/bin/env node
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { snapshotJson } from "./adapter-normalize.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import { extractActionsArtifactZip } from "./artifact-store.mjs"
import {
  authenticateHistoricalRun,
  authenticateOriginalNpmArchive,
} from "./historical-publication.mjs"
import { HISTORICAL_PUBLICATION_MANIFEST_PATH } from "./historical-publication-data.mjs"
import {
  canonicalHistoricalPublicationRecordBytes,
  HISTORICAL_PUBLICATION_POLICY_REVISION,
  HISTORICAL_PUBLICATION_RECORD_PATH,
  HISTORICAL_0155_INCIDENT as INCIDENT,
  parseHistoricalPublicationRecord,
} from "./historical-publication-record.mjs"
import { manifestSha256, validateSealedReleaseManifest } from "./manifest.mjs"
import { parseReleaseMarker } from "./metadata.mjs"
import { createNpmAuditVerifier, parseIncidentNpmAuditResult } from "./npm-audit.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "./npm-evidence.mjs"
import { exactRegistryTarball } from "./observe.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const PREFIX = "scripts/release/historical-publications/evidence/v0.15.5/"
const MAX_MS = 15 * 60_000
const MAX_BYTES = 64 * 1024 * 1024
const CANDIDATE = Object.freeze({
  version: INCIDENT.version,
  commitSha: INCIDENT.commitSha,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: INCIDENT.publisherWorkflow,
})
const SHA = /^[a-f0-9]{40}$/u
/** Every current repository release owner must have no queued or active invocation. */
export const HISTORICAL_CAPTURE_OWNER_WORKFLOWS = Object.freeze([
  ".github/workflows/publish-chart.yml",
  ".github/workflows/published-artifact-verify.yml",
  ".github/workflows/release-postpublication-audit.yml",
  ".github/workflows/release-postpublication.yml",
  ".github/workflows/release.yml",
])

/** Authenticate stable GitHub identity and the complete inventory of release owners. */
export async function captureHistoricalBracket({ github, reviewedCommit, signal }) {
  signal?.throwIfAborted()
  const call = async (method, args = {}) => {
    signal?.throwIfAborted()
    const result = await github[method](args, { signal })
    signal?.throwIfAborted()
    return result
  }
  const read = async (method, args = {}) => present(await call(method, args))
  const repository = await read("getRepository")
  requireThat(
    repository.id === INCIDENT.repositoryId &&
      repository.full_name === INCIDENT.repository &&
      repository.default_branch === "main",
    "Repository identity differs",
  )
  const operator = await read("getAuthenticatedUser")
  requireThat(
    Number.isSafeInteger(operator.id) &&
      operator.id > 0 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(operator.login),
    "Authenticated operator differs",
  )
  const main = await read("getRef", { ref: "heads/main" })
  requireThat(
    main.ref === "refs/heads/main" && main.object?.type === "commit" && SHA.test(main.object.sha),
    "Main identity differs",
  )
  const ancestry = await read("compareCommits", {
    baseSha: reviewedCommit,
    headSha: main.object.sha,
  })
  requireThat(
    ["ahead", "identical"].includes(ancestry.status) &&
      ancestry.merge_base_commit?.sha === reviewedCommit,
    "Reviewed controller is not on main",
  )
  const releases = await read("listReleases")
  requireThat(
    Array.isArray(releases) &&
      releases.length <= 1024 &&
      new Set(releases.map((x) => x.id)).size === releases.length,
    "Incomplete Release inventory",
  )
  const workflows = await read("listRepositoryWorkflowsComplete")
  requireThat(Array.isArray(workflows), "Incomplete workflow inventory")
  const owners = []
  const ownerIds = new Set()
  for (const workflowPath of HISTORICAL_CAPTURE_OWNER_WORKFLOWS) {
    const matches = workflows.filter((x) => x.path === workflowPath)
    requireThat(
      matches.length === 1 &&
        matches[0].state === "active" &&
        Number.isSafeInteger(matches[0].id) &&
        matches[0].id > 0 &&
        !ownerIds.has(matches[0].id),
      "Owner identity differs",
    )
    ownerIds.add(matches[0].id)
    const workflow = matches[0]
    const runs = await read("listWorkflowRunsAllShasComplete", { workflowId: workflow.id })
    requireThat(
      Array.isArray(runs) &&
        runs.every(
          (run) =>
            run.status === "completed" &&
            run.workflow_id === workflow.id &&
            run.path === workflowPath &&
            run.repository?.id === INCIDENT.repositoryId &&
            run.repository.full_name === INCIDENT.repository &&
            Number.isSafeInteger(run.id) &&
            run.id > 0 &&
            SHA.test(run.head_sha) &&
            Number.isSafeInteger(run.run_attempt) &&
            run.run_attempt > 0 &&
            typeof run.conclusion === "string" &&
            run.conclusion.length > 0,
        ) &&
        new Set(runs.map((run) => run.id)).size === runs.length,
      "A release owner is active, queued, incomplete or malformed",
    )
    const requiredRunId =
      workflowPath === INCIDENT.publisherWorkflow
        ? INCIDENT.publisherRunId
        : workflowPath === INCIDENT.auditWorkflow
          ? INCIDENT.auditRunId
          : null
    if (requiredRunId !== null)
      requireThat(
        runs.some(
          (run) =>
            run.id === requiredRunId &&
            run.run_attempt === 1 &&
            run.head_sha === INCIDENT.commitSha &&
            run.conclusion === "success",
        ),
        "Original producing run is absent from owner inventory",
      )
    owners.push({ workflow, runs })
  }
  signal?.throwIfAborted()
  return snapshotJson({ repository, operator, main: main.object.sha, releases, owners })
}

/** Read and authenticate the actual original immutable evidence, without future capture facts. */
export async function captureHistoricalOriginal({ github, now = Date.now, signal }) {
  signal?.throwIfAborted()
  const call = async (method, args = {}) => {
    signal?.throwIfAborted()
    const result = await github[method](args, { signal })
    signal?.throwIfAborted()
    return result
  }
  const read = async (method, args = {}) => present(await call(method, args))
  const files = new Map()
  const release = await read("getRelease", { releaseId: INCIDENT.releaseId })
  requireThat(
    release.id === INCIDENT.releaseId &&
      release.tag_name === INCIDENT.tag &&
      release.immutable === true &&
      release.draft === false &&
      typeof release.body === "string",
    "Original immutable Release differs",
  )
  const marker = parseReleaseMarker(release.body)
  requireThat(
    marker.phase === "AUDIT_VERIFIED" &&
      marker.version === INCIDENT.version &&
      marker.commitSha === INCIDENT.commitSha &&
      marker.tag === INCIDENT.tag &&
      marker.manifestSha256 === INCIDENT.manifestSha256 &&
      marker.npmEvidenceSha256 === INCIDENT.originalReceiptSha256 &&
      marker.audit?.workflowRunId === INCIDENT.auditRunId &&
      marker.audit.runAttempt === 1 &&
      marker.audit.conclusion === "success",
    "Current Release marker disagrees with original evidence",
  )
  const ref = await read("getRef", { ref: `tags/${INCIDENT.tag}` })
  const tag = await read("getGitTag", { tagSha: INCIDENT.tagObjectSha })
  requireThat(
    ref.ref === INCIDENT.publisherRef &&
      ref.object?.type === "tag" &&
      ref.object.sha === INCIDENT.tagObjectSha &&
      tag.sha === INCIDENT.tagObjectSha &&
      tag.tag === INCIDENT.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === INCIDENT.commitSha,
    "Original tag identity differs",
  )
  const assets = await read("listReleaseAssets", { releaseId: INCIDENT.releaseId })
  requireThat(
    Array.isArray(assets) &&
      assets.length <= 1024 &&
      new Set(assets.map((x) => x.id)).size === assets.length &&
      new Set(assets.map((x) => x.name)).size === assets.length,
    "Original asset inventory differs",
  )
  const assetBytes = async (name) => {
    const matches = assets.filter((x) => x.name === name)
    requireThat(matches.length === 1, "Original asset identity differs")
    const asset = matches[0]
    requireThat(
      Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 2 * 1024 * 1024,
      "Original asset size differs",
    )
    const bytes = binary(
      await call("downloadReleaseAsset", { assetId: asset.id, maximumBytes: asset.size }),
      asset.size,
    )
    requireThat(asset.digest === `sha256:${hash(bytes)}`, "Original asset service digest differs")
    return { asset, bytes }
  }
  const retainedManifest = await assetBytes("manifest.json")
  requireThat(
    hash(retainedManifest.bytes) === INCIDENT.manifestSha256,
    "Original manifest service bytes differ",
  )
  const manifest = validateSealedReleaseManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retainedManifest.bytes)),
    { candidate: INCIDENT },
  )
  requireThat(
    manifestSha256(manifest) === hash(retainedManifest.bytes),
    "Original manifest canonical bytes differ",
  )
  files.set(HISTORICAL_PUBLICATION_MANIFEST_PATH, retainedManifest.bytes)
  const run = async (runId, workflow) => {
    const actual = await read("getActionsRun", { runId })
    const jobs = await read("listActionsRunJobsComplete", { runId })
    requireThat(
      Array.isArray(jobs) && jobs.length > 0 && jobs.length <= 256,
      "Original jobs incomplete",
    )
    const expected = {
      repository: actual.repository?.full_name,
      repositoryId: actual.repository?.id,
      runId: actual.id,
      runAttempt: actual.run_attempt,
      workflow: actual.path,
      ref: `refs/tags/${actual.head_branch}`,
      commitSha: actual.head_sha,
      status: actual.status,
      conclusion: actual.conclusion,
      jobs: jobs.map(({ id, name, status, conclusion }) => ({ id, name, status, conclusion })),
    }
    requireThat(
      expected.runId === runId &&
        expected.workflow === workflow &&
        expected.runAttempt === 1 &&
        expected.repositoryId === INCIDENT.repositoryId &&
        expected.repository === INCIDENT.repository &&
        expected.ref === INCIDENT.publisherRef &&
        expected.commitSha === INCIDENT.commitSha &&
        expected.status === "completed" &&
        expected.conclusion === "success",
      "Original producing run differs",
    )
    const producingJob = workflow === INCIDENT.publisherWorkflow ? "publish-npm" : "verify"
    requireThat(
      expected.jobs.filter((x) => x.name === producingJob && x.conclusion === "success").length ===
        1 &&
        expected.jobs.every(
          (x) => x.status === "completed" && ["success", "skipped"].includes(x.conclusion),
        ),
      "Original producing jobs differ",
    )
    await authenticateHistoricalRun({
      github: {
        getActionsRun: (args) => call("getActionsRun", args),
        getActionsRunAttempt: (args) => call("getActionsRunAttempt", args),
        listActionsRunJobsComplete: (args) => call("listActionsRunJobsComplete", args),
      },
      expected,
    })
    return expected
  }
  const publisher = await run(INCIDENT.publisherRunId, INCIDENT.publisherWorkflow)
  const auditRun = await run(INCIDENT.auditRunId, INCIDENT.auditWorkflow)
  const metadata = await read("getActionsArtifact", { artifactId: INCIDENT.artifactId })
  const inventory = await read("listActionsRunArtifacts", { runId: INCIDENT.publisherRunId })
  requireThat(
    Array.isArray(inventory) &&
      inventory.length <= 1024 &&
      new Set(inventory.map((x) => x.id)).size === inventory.length,
    "Original artifact inventory differs",
  )
  const matches = inventory.filter(
    (x) => x.id === INCIDENT.artifactId || x.name === INCIDENT.artifactName,
  )
  const validateArtifact = (x) =>
    requireThat(
      x.id === INCIDENT.artifactId &&
        x.name === INCIDENT.artifactName &&
        x.digest === INCIDENT.archiveServiceDigest &&
        Number.isSafeInteger(x.size_in_bytes) &&
        x.size_in_bytes > 0 &&
        x.size_in_bytes <= MAX_BYTES &&
        typeof x.expired === "boolean" &&
        x.workflow_run?.id === INCIDENT.publisherRunId &&
        x.workflow_run.head_sha === INCIDENT.commitSha &&
        typeof x.expires_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(x.expires_at) &&
        Number.isFinite(Date.parse(x.expires_at)),
      "Original artifact metadata differs",
    )
  validateArtifact(metadata)
  requireThat(matches.length === 1, "Original artifact unique association differs")
  validateArtifact(matches[0])
  requireThat(
    matches[0].expired === metadata.expired &&
      matches[0].size_in_bytes === metadata.size_in_bytes &&
      matches[0].expires_at === metadata.expires_at,
    "Original artifact metadata drift",
  )
  const download = await call("downloadActionsArtifact", {
    artifactId: INCIDENT.artifactId,
    maximumBytes: metadata.size_in_bytes,
  })
  const archive = binary(download, metadata.size_in_bytes)
  requireThat(
    archive.length === metadata.size_in_bytes &&
      hash(archive) === INCIDENT.archiveServiceDigest.slice(7),
    "Original archive bytes differ",
  )
  const members = extractActionsArtifactZip(archive, { maxOutputBytes: 2 * 1024 * 1024 })
  requireThat(
    members.length === 1 && members[0].name === "npm-evidence.json",
    "Original archive members differ",
  )
  const context = { candidate: INCIDENT, manifest, manifestSha256: INCIDENT.manifestSha256 }
  const npmEvidence = parseNpmEvidence(members[0].bytes, context)
  const receiptBytes = canonicalNpmEvidenceBytes(npmEvidence, context)
  requireThat(
    Buffer.from(members[0].bytes).equals(receiptBytes) &&
      hash(receiptBytes) === INCIDENT.originalReceiptSha256,
    "Original canonical npm receipt differs",
  )
  const artifact = {
    id: metadata.id,
    name: metadata.name,
    runId: metadata.workflow_run.id,
    serviceDigest: metadata.digest,
    size: archive.length,
    sha256: hash(archive),
    path: `${PREFIX}original-artifact.zip`,
  }
  files.set(artifact.path, archive)
  files.set(`${PREFIX}npm-evidence.json`, receiptBytes)
  files.set(
    `${PREFIX}original-artifact.json`,
    canonical({
      id: metadata.id,
      name: metadata.name,
      runId: metadata.workflow_run.id,
      headSha: metadata.workflow_run.head_sha,
      serviceDigest: metadata.digest,
      size: archive.length,
      expired: metadata.expired,
      expiresAt: new Date(metadata.expires_at).toISOString(),
      observedAt: iso(now()),
    }),
  )
  const receipts = []
  for (const name of ["audit-result.json", `audit-attempt-${INCIDENT.auditRunId}-1.json`]) {
    const { asset, bytes } = await assetBytes(name)
    const receipt = parseAuditResult(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    )
    requireThat(
      bytes.equals(canonicalAuditResultBytes(receipt)) &&
        receipt.conclusion === "success" &&
        receipt.workflowRunId === INCIDENT.auditRunId &&
        receipt.runAttempt === 1 &&
        receipt.version === INCIDENT.version &&
        receipt.commitSha === INCIDENT.commitSha &&
        receipt.manifestSha256 === INCIDENT.manifestSha256,
      "Original audit receipt differs",
    )
    files.set(`${PREFIX}${name}`, bytes)
    receipts.push({ id: asset.id, name, size: bytes.length, sha256: hash(bytes), receipt })
  }
  requireThat(
    receipts[0].sha256 === receipts[1].sha256 &&
      marker.audit.canonicalSha256 === receipts[0].sha256 &&
      marker.audit.attemptSha256 === receipts[1].sha256 &&
      marker.audit.attemptAssetName === receipts[1].name,
    "Original audit aliases or editable marker disagree",
  )
  signal?.throwIfAborted()
  return {
    manifest,
    original: { publisher, artifact, npmEvidence, audit: { run: auditRun, receipts } },
    files,
    facts: snapshotJson({ release, ref, tag, assets, artifact: metadata, publisher, auditRun }),
  }
}

/** Read one fresh all-package byte sweep and official proofs, retaining incident command output without authority. */
export async function captureHistoricalSweep({ manifest, npm, audit, now = Date.now, signal }) {
  const startedAt = iso(now())
  signal?.throwIfAborted()
  const entries = snapshotJson(manifest.packages)
  requireThat(
    entries.length === 21 && new Set(entries.map((x) => x.name)).size === 21,
    "Sweep requires the complete manifest inventory",
  )
  const observations = []
  for (const entry of entries) {
    signal?.throwIfAborted()
    const result = await npm.observePackageVersion({
      name: entry.name,
      version: entry.version,
      signal,
    })
    requireThat(result?.status === "PRESENT", "Registry package incomplete")
    signal?.throwIfAborted()
    const pkg = snapshotJson(result.package)
    const unscoped = entry.name.split("/").at(-1)
    requireThat(
      pkg.name === entry.name &&
        pkg.version === entry.version &&
        pkg.integrity === entry.npmIntegrity &&
        /^[a-f0-9]{40}$/u.test(pkg.shasum) &&
        pkg.tarballUrl ===
          `https://registry.npmjs.org/${entry.name}/-/${unscoped}-${entry.version}.tgz`,
      "Registry package identity differs",
    )
    const downloaded = await npm.downloadRegistryTarball({ tarballUrl: pkg.tarballUrl, signal })
    signal?.throwIfAborted()
    requireThat(
      downloaded?.status === "PRESENT" && exactRegistryTarball(downloaded.tarball, pkg, entry),
      "Registry exact bytes differ",
    )
    observations.push({
      package: pkg,
      tarball: {
        url: downloaded.tarball.url,
        size: downloaded.tarball.size,
        sha1: downloaded.tarball.sha1,
        sha256: downloaded.tarball.sha256,
        sha512: downloaded.tarball.sha512,
      },
    })
  }
  const unaffected = entries.filter((x) => x.name !== INCIDENT.exceptionalPackage)
  const ordinary = await audit.verifyPackages({ entries: unaffected, candidate: CANDIDATE })
  requireThat(
    Array.isArray(ordinary) &&
      ordinary.length === 20 &&
      ordinary.every(
        (proof, index) =>
          proof.name === unaffected[index].name &&
          proof.version === unaffected[index].version &&
          proof.status === "verified" &&
          proof.signature?.status === "valid",
      ),
    "Ordinary all-package official proofs incomplete",
  )
  signal?.throwIfAborted()
  const command = await audit.captureIncidentPackageCommand({
    entry: entries.find((x) => x.name === INCIDENT.exceptionalPackage),
    candidate: CANDIDATE,
  })
  signal?.throwIfAborted()
  return {
    startedAt,
    finishedAt: iso(now()),
    packages: entries.map((entry) => ({
      ...entry,
      verification:
        entry.name === INCIDENT.exceptionalPackage ? "historical-provenance" : "complete",
    })),
    observations,
    ordinary,
    command: snapshotJson(command),
  }
}

/** Capture a proposed historical assertion; no release or admitted repository data is changed. */
export async function captureHistorical0155({
  github,
  npm,
  audit,
  reviewedCommit,
  now = Date.now,
  wait = (ms, { signal }) => delay(ms, undefined, { signal }),
  signal: externalSignal,
  readOriginal = captureHistoricalOriginal,
  readBracket = captureHistoricalBracket,
  readSweep = captureHistoricalSweep,
}) {
  externalSignal?.throwIfAborted()
  requireThat(
    typeof reviewedCommit === "string" && SHA.test(reviewedCommit),
    "Invalid reviewed controller",
  )
  const started = now()
  iso(started)
  const abort = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, abort.signal]) : abort.signal
  const timer = setTimeout(() => abort.abort(new Error("Capture exceeded fifteen minutes")), MAX_MS)
  timer.unref?.()
  const active = () => {
    signal.throwIfAborted()
    const current = now()
    requireThat(
      Number.isSafeInteger(current) && current >= started && current - started <= MAX_MS,
      "Capture exceeded fifteen minutes or clock moved backwards",
    )
  }
  const stage = async (operation) => {
    active()
    const value = await abortable(operation(), signal)
    active()
    return value
  }
  try {
    const original = await stage(() => readOriginal({ github, now, signal }))
    const before = await stage(() => readBracket({ github, reviewedCommit, signal }))
    const bracketBeforeAt = iso(now())
    const first = await stage(() =>
      readSweep({ manifest: original.manifest, npm, audit, now, signal }),
    )
    const pause = Math.max(0, 60_000 - (now() - Date.parse(first.startedAt)))
    await stage(() => wait(pause, { signal }))
    const second = await stage(() =>
      readSweep({ manifest: original.manifest, npm, audit, now, signal }),
    )
    const afterOriginal = await stage(() => readOriginal({ github, now, signal }))
    const after = await stage(() => readBracket({ github, reviewedCommit, signal }))
    const bracketAfterAt = iso(now())
    const factsBefore = canonical({ github: before, original: original.facts })
    const factsAfter = canonical({ github: after, original: afterOriginal.facts })
    requireThat(
      factsBefore.equals(factsAfter) &&
        canonical(original.original).equals(canonical(afterOriginal.original)) &&
        manifestSha256(original.manifest) === manifestSha256(afterOriginal.manifest),
      "GitHub identity or original evidence drifted during capture",
    )
    requireThat(
      Date.parse(second.startedAt) - Date.parse(first.startedAt) >= 60_000,
      "Sweep spacing is less than sixty seconds",
    )
    const files = new Map([...original.files].map(([file, bytes]) => [file, Buffer.from(bytes)]))
    files.set(`${PREFIX}bracket-facts.json`, factsBefore)
    const sweeps = [first, second].map((sweep, index) => {
      const bytes = canonical(sweep)
      files.set(`${PREFIX}sweep-${index === 0 ? "first" : "second"}.json`, bytes)
      return {
        startedAt: sweep.startedAt,
        finishedAt: sweep.finishedAt,
        evidenceSha256: hash(bytes),
        packages: sweep.packages,
      }
    })
    let total = 0
    const supportingEvidence = [...files]
      .map(([file, bytes]) => {
        total += bytes.length
        requireThat(
          total <= MAX_BYTES && bytes.length > 0,
          "Supporting evidence exceeds capture byte bounds",
        )
        return { path: file, size: bytes.length, sha256: hash(bytes) }
      })
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
    const record = {
      schemaVersion: 1,
      policyRevision: HISTORICAL_PUBLICATION_POLICY_REVISION,
      incident: INCIDENT,
      capture: {
        operator: before.operator,
        controllerSha: reviewedCommit,
        startedAt: iso(started),
        finishedAt: iso(now()),
      },
      original: original.original,
      brackets: [bracketBeforeAt, bracketAfterAt].map((observedAt) => ({
        observedAt,
        factsSha256: hash(factsBefore),
        releaseOwnersInactive: true,
      })),
      sweeps,
      supportingEvidence,
    }
    // Only completed actual observations can produce this record. The raw command bytes
    // contain no record digest, so strict final proof parsing has no support digest cycle.
    const recordBytes = canonicalHistoricalPublicationRecordBytes(record, {
      manifest: original.manifest,
    })
    const admitted = parseHistoricalPublicationRecord(recordBytes, { manifest: original.manifest })
    authenticateOriginalNpmArchive(files.get(admitted.original.artifact.path), {
      record: admitted,
      manifest: original.manifest,
    })
    for (const sweep of [first, second]) {
      const proof = parseIncidentNpmAuditResult(sweep.command, {
        entry: original.manifest.packages.find(
          (entry) => entry.name === INCIDENT.exceptionalPackage,
        ),
        candidate: INCIDENT,
        manifest: original.manifest,
        record: admitted,
        npmVersion: "11.17.0",
      })
      if (proof.kind !== "historical-provenance")
        throw Object.assign(
          new Error("Ordinary npm verification is available; historical capture must stop"),
          { code: "ORDINARY_NPM_VERIFICATION_AVAILABLE" },
        )
    }
    active()
    return { recordBytes, files }
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

/** Run the read-only operator command from an exact clean reviewed checkout. */
export async function runHistorical0155Capture(
  argv,
  {
    cwd = process.cwd(),
    environment = process.env,
    readCheckout = readHistoricalCheckout,
    createReaders = readers,
    fileSystem = fs,
    capture = captureHistorical0155,
  } = {},
) {
  requireThat(
    Array.isArray(argv) && argv.length === 4,
    "Expected --reviewed-commit SHA --output PATH",
  )
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    requireThat(
      ["--reviewed-commit", "--output"].includes(argv[i]) &&
        !args.has(argv[i]) &&
        typeof argv[i + 1] === "string" &&
        argv[i + 1].length > 0,
      "Arguments must be exact",
    )
    args.set(argv[i], argv[i + 1])
  }
  const reviewedCommit = args.get("--reviewed-commit")
  requireThat(SHA.test(reviewedCommit) && args.has("--output"), "Invalid reviewed commit or output")
  const state = await readCheckout(cwd, { environment })
  requireThat(
    state.head === reviewedCommit && state.status === "",
    "Capture requires an exact clean reviewed checkout",
  )
  const output = path.resolve(cwd, args.get("--output"))
  await assertSafeOutputPath({ cwd, output, fileSystem })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error("Capture exceeded fifteen minutes")), MAX_MS)
  timer.unref?.()
  let services
  let auditDisposed = false
  const interrupt = () => abort.abort(new Error("Capture interrupted"))
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    services = await createReaders(environment, { signal: abort.signal })
    const result = await capture({ ...services, reviewedCommit, signal: abort.signal })
    abort.signal.throwIfAborted()
    const finalCheckout = await readCheckout(cwd, { environment })
    requireThat(
      finalCheckout.head === reviewedCommit && finalCheckout.status === "",
      "Capture requires an exact clean reviewed checkout",
    )
    await services?.audit?.dispose()
    auditDisposed = true
    abort.signal.throwIfAborted()
    await writeHistoricalCaptureOutput({ cwd, output, result, fileSystem, signal: abort.signal })
    abort.signal.throwIfAborted()
    return { output, sha256: hash(result.recordBytes) }
  } finally {
    clearTimeout(timer)
    abort.abort()
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    if (!auditDisposed) await services?.audit?.dispose()
  }
}
/** Read an exact ordinary checkout without ambient Git redirection or hidden index exclusions. */
export async function readHistoricalCheckout(
  cwd,
  { run = promisify(execFile), environment = process.env } = {},
) {
  requireThat(
    !Object.keys(environment).some((key) => /^GIT_/iu.test(key)),
    "Capture rejects ambient Git context",
  )
  await assertUnaliasedDirectory(cwd, fs)
  const options = {
    cwd,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
    env: { ...environment },
  }
  const git = (args) =>
    run("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], options)
  const [head, status, root, flags] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=normal"]),
    git(["rev-parse", "--show-toplevel"]),
    git(["ls-files", "-v", "-z"]),
  ])
  requireThat(
    (await fs.realpath(root.stdout.trim())) === (await fs.realpath(cwd)),
    "Capture requires the actual checkout root",
  )
  requireThat(
    flags.stdout
      .split("\0")
      .filter(Boolean)
      .every((file) => file.startsWith("H ")),
    "Capture disallows hidden index exclusions",
  )
  return { head: head.stdout.trim(), status: status.stdout }
}
async function readers(environment, { signal }) {
  const token = environment.GITHUB_TOKEN
  requireThat(
    typeof token === "string" && token.length > 0 && !/[\r\n]/u.test(token),
    "GITHUB_TOKEN is required",
  )
  const audit = await createNpmAuditVerifier({
    runNpm: createReleasePreparationRunner({
      commandTimeoutMs: 120_000,
      overallTimeoutMs: MAX_MS,
      maxOutputBytes: 2 * 1024 * 1024,
    }),
    environment,
    signal,
  })
  return {
    github: createGitHubReader({
      owner: "cacheplane",
      repo: "b4run",
      repositoryId: String(INCIDENT.repositoryId),
      token,
      timeoutMs: 15000,
      paginationTimeoutMs: 60000,
    }),
    npm: createNpmReader(),
    audit,
  }
}
function present(result) {
  requireThat(result?.status === "PRESENT", "Required read was incomplete")
  return snapshotJson(result.value)
}
function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}

function binary(result, size) {
  requireThat(
    result?.status === "PRESENT" &&
      typeof result.contentBase64 === "string" &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= MAX_BYTES,
    "Binary read incomplete or unbounded",
  )
  const bytes = Buffer.from(result.contentBase64, "base64")
  requireThat(
    bytes.length === size &&
      bytes.toString("base64") === result.contentBase64 &&
      (result.bodyBytes === undefined || result.bodyBytes === size),
    "Binary byte identity differs",
  )
  return bytes
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function canonical(value) {
  return Buffer.from(`${JSON.stringify(sort(value))}\n`)
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    )
  return value
}
function iso(value) {
  requireThat(Number.isSafeInteger(value) && value >= 0, "Invalid capture clock")
  return new Date(value).toISOString()
}

/** Write only a new private capture directory outside the checkout, with exclusive private files. */
export async function writeHistoricalCaptureOutput({
  cwd,
  output,
  result,
  fileSystem = fs,
  signal,
}) {
  signal?.throwIfAborted()
  await assertSafeOutputPath({ cwd, output, fileSystem })
  const manifestBytes = result.files.get(HISTORICAL_PUBLICATION_MANIFEST_PATH)
  requireThat(
    Buffer.isBuffer(manifestBytes) && hash(manifestBytes) === INCIDENT.manifestSha256,
    "Output manifest differs",
  )
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes))
  const record = parseHistoricalPublicationRecord(result.recordBytes, { manifest })
  requireThat(
    result.files.size === record.supportingEvidence.length,
    "Output support inventory differs",
  )
  for (const [file, bytes] of result.files) {
    const declared = record.supportingEvidence.find((entry) => entry.path === file)
    requireThat(
      declared &&
        bytes instanceof Uint8Array &&
        bytes.length === declared.size &&
        hash(bytes) === declared.sha256,
      "Output support identity differs",
    )
  }
  signal?.throwIfAborted()
  await fileSystem.mkdir(output, { mode: 0o700 })
  const directories = new Set([output])
  const files = new Map([[HISTORICAL_PUBLICATION_RECORD_PATH, result.recordBytes], ...result.files])
  for (const [relative, bytes] of files) {
    signal?.throwIfAborted()
    requireThat(
      relative === HISTORICAL_PUBLICATION_RECORD_PATH || relative.startsWith(PREFIX),
      "Output path differs",
    )
    const target = path.resolve(output, relative)
    requireThat(target.startsWith(`${output}${path.sep}`), "Output path escaped")
    const segments = path.relative(output, path.dirname(target)).split(path.sep)
    let directory = output
    for (const segment of segments) {
      directory = path.join(directory, segment)
      if (!directories.has(directory)) {
        await fileSystem.mkdir(directory, { mode: 0o700 })
        directories.add(directory)
      }
      const metadata = await fileSystem.lstat(directory)
      requireThat(
        metadata.isDirectory() &&
          !metadata.isSymbolicLink() &&
          (metadata.mode & 0o7777) === 0o700 &&
          (await fileSystem.realpath(directory)) === directory,
        "Output directory identity differs",
      )
    }
    signal?.throwIfAborted()
    await fileSystem.writeFile(target, bytes, { flag: "wx", mode: 0o600 })
    const metadata = await fileSystem.lstat(target)
    requireThat(
      metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o7777) === 0o600,
      "Output file identity differs",
    )
  }
}
async function assertSafeOutputPath({ cwd, output, fileSystem }) {
  requireThat(
    typeof output === "string" && path.isAbsolute(output) && path.resolve(output) === output,
    "Output must be an exact absolute path",
  )
  const checkoutRoot = await assertUnaliasedDirectory(cwd, fileSystem)
  requireThat(
    output !== checkoutRoot && !output.startsWith(`${checkoutRoot}${path.sep}`),
    "Output must be outside the repository checkout",
  )
  let current = path.parse(output).root
  const segments = path.relative(current, path.dirname(output)).split(path.sep).filter(Boolean)
  for (const segment of segments) {
    current = path.join(current, segment)
    const metadata = await fileSystem.lstat(current)
    requireThat(
      metadata.isDirectory() &&
        !metadata.isSymbolicLink() &&
        (await fileSystem.realpath(current)) === current,
      "Output ancestor is an alias or not a directory",
    )
  }
  try {
    await fileSystem.lstat(output)
    throw new Error("Output already exists")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}
async function assertUnaliasedDirectory(directory, fileSystem) {
  requireThat(
    typeof directory === "string" &&
      path.isAbsolute(directory) &&
      path.resolve(directory) === directory,
    "Checkout must be an exact absolute directory",
  )
  let current = path.parse(directory).root
  for (const segment of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const metadata = await fileSystem.lstat(current)
    requireThat(
      metadata.isDirectory() &&
        !metadata.isSymbolicLink() &&
        (await fileSystem.realpath(current)) === current,
      "Checkout ancestor is an alias or not a directory",
    )
  }
  return directory
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason)
    signal.addEventListener("abort", cancelled, { once: true })
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancelled))
    if (signal.aborted) cancelled()
  })
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runHistorical0155Capture(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      if (error?.code === "ORDINARY_NPM_VERIFICATION_AVAILABLE")
        console.error(
          "Ordinary npm verification is available; stop historical admission and use the normal observation path.",
        )
      console.error(
        "Historical 0.15.5 capture failed; no release state or admitted repository record was changed. Preserve private partial output for inspection.",
      )
      process.exitCode = 1
    },
  )
}
