import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { snapshotJson } from "./adapter-normalize.mjs"
import {
  adaptFirstPublicationNpmReader,
  createFirstPublicationNpmReader,
  createNpmReader,
} from "./adapters/npm.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  canonicalManifestBytes,
  manifestSha256,
  parseSealedReleaseManifest,
  validateSealedReleaseManifest,
} from "./manifest.mjs"
import { createNpmAuditVerifier } from "./npm-audit.mjs"
import {
  assertBootstrapWindow,
  BOOTSTRAP_AUTHORIZATION_VARIABLE,
  BOOTSTRAP_TOKEN_VARIABLE,
  NPM_AUTH_MODES,
  parseBootstrapAuthorization,
  redactBootstrapCredential,
  redactBootstrapError,
  validateBootstrapAuthorization,
  validateBootstrapToken,
} from "./npm-bootstrap.mjs"
import {
  canonicalNpmEvidenceBytes,
  NPM_EVIDENCE_MAX_BYTES,
  parseNpmEvidence,
} from "./npm-evidence.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"
import { canonicalReleaseRecordBytes, parseReleaseRecord } from "./release-record.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const PUBLISHER_FLAGS = Object.freeze([
  "--artifact-dir",
  "--candidate",
  "--github-output",
  "--record",
  "--report",
])
// Optional. Default oidc: npm trusted publishing with every registry credential stripped.
// bootstrap: the explicit, expiring, candidate-bound first-publication exception
// (scripts/release/npm-bootstrap.mjs). There is never an automatic fallback between them.
const PUBLISHER_AUTH_MODE_FLAG = "--npm-auth-mode"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SHA512_PATTERN = /^[0-9a-f]{128}$/u
const MAX_CANDIDATE_BYTES = 16 * 1024
const POLL_DELAY_MS = 2_000
const PUBLISH_COMMAND_TIMEOUT_MS = 5 * 60_000
const EXPECTED_REPOSITORY = "https://github.com/cacheplane/b4run"

// One registry propagation budget per package covers exact-version absence,
// metadata/dist-tag lag, explicit audit-pending evidence, and tarball HTTP 404.
// Pending state changes never restart the clock or the fast polling cadence.
// Identity, integrity, signature, provenance, and non-404 download failures remain
// fatal. The 25-minute overall deadline and 30-minute job still bound the run;
// this window absorbs temporary propagation lag without republishing accepted bytes.
// Retain the exported tarball deadline name for existing callers.
const TARBALL_FAST_POLL_ATTEMPTS = 10
const TARBALL_SLOW_POLL_DELAY_MS = 10_000
export const TARBALL_CONVERGENCE_DEADLINE_MS = 10 * 60_000

export const PUBLISHER_OVERALL_TIMEOUT_MS = 25 * 60_000

export const PUBLISHER_SPARSE_FILES = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/adapters/npm.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/manifest.mjs",
  "scripts/release/npm-audit.mjs",
  "scripts/release/npm-bootstrap.mjs",
  "scripts/release/npm-evidence.mjs",
  "scripts/release/process-runner.mjs",
  "scripts/release/publisher.mjs",
  "scripts/release/release-record.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/topology.mjs",
])

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    await runPublisherCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function publishManifestSerially({
  candidate,
  manifest,
  observeRegistry,
  downloadRegistryTarball,
  verifyPackage,
  publishTarball,
  poll,
  log,
  now = Date.now,
  firstPublication = false,
}) {
  const identity = validateCandidate(candidate)
  const sealedManifest = validateSealedReleaseManifest(manifest, { candidate: identity })
  assertFunction(observeRegistry, "observeRegistry")
  assertFunction(downloadRegistryTarball, "downloadRegistryTarball")
  assertFunction(verifyPackage, "verifyPackage")
  assertFunction(publishTarball, "publishTarball")
  assertFunction(poll, "poll")
  assertFunction(log, "log")
  assertFunction(now, "now")
  if (typeof firstPublication !== "boolean") {
    throw new TypeError("firstPublication must be a boolean")
  }
  // Only the explicitly selected first-publication mode may read a whole-package absence;
  // the default publisher keeps requiring a present metadata observation for every name.
  const observeMetadata = (registry, name) =>
    observePackageMetadata(registry, name, { firstPublication })

  const initial = []
  let candidateStarted = false
  for (const entry of sealedManifest.packages) {
    const metadata = await observeMetadata(observeRegistry, entry.name)
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate: identity,
      downloadRegistryTarball,
    })
    candidateStarted ||= isPublished(analyzed)
    initial.push(analyzed)
  }
  const initialLatest = newerLatest(initial, identity.version)
  if (initialLatest !== null) {
    return candidateStarted
      ? failNewerLatest(initialLatest.name)
      : supersededResult(identity, sealedManifest)
  }

  for (let index = 0; index < sealedManifest.packages.length; index += 1) {
    const entry = sealedManifest.packages[index]
    let state = initial[index]
    if (isPublished(state)) {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        observeMetadata,
        downloadRegistryTarball,
        verifyPackage,
        poll,
        log,
        now,
      })
      log({ event: "package-verified", name: entry.name })
      continue
    }

    const current = await observeVersion(observeRegistry, entry)
    state = await analyzeVersion({
      entry,
      metadata: state.metadata,
      version: current,
      candidate: identity,
      downloadRegistryTarball,
    })
    if (isPublished(state)) {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        observeMetadata,
        downloadRegistryTarball,
        verifyPackage,
        poll,
        log,
        now,
      })
      log({ event: "package-recovered", name: entry.name })
      continue
    }

    const sweep = await sweepLatest({ manifest: sealedManifest, observeRegistry, observeMetadata })
    const latest = newerLatest(sweep, identity.version)
    if (latest !== null) {
      return candidateStarted
        ? failNewerLatest(latest.name)
        : supersededResult(identity, sealedManifest)
    }
    if (sweep[index].metadata.metadata.latest === identity.version) {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        observeMetadata,
        downloadRegistryTarball,
        verifyPackage,
        poll,
        log,
        now,
      })
      log({ event: "package-recovered", name: entry.name })
      continue
    }

    await publishTarball({ entry })
    candidateStarted = true
    log({ event: "package-publish-accepted", name: entry.name })
    await waitUntilVerified({
      entry,
      candidate: identity,
      observeRegistry,
      observeMetadata,
      downloadRegistryTarball,
      verifyPackage,
      poll,
      log,
      now,
    })
  }

  const packages = []
  for (const entry of sealedManifest.packages) {
    const metadata = await observeMetadata(observeRegistry, entry.name)
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate: identity,
      downloadRegistryTarball,
    })
    if (analyzed.status !== "present" || !registryReady(analyzed, identity)) {
      throw new Error(`Final npm verification is incomplete for ${entry.name}`)
    }
    const audit = await observeNpmAudit(verifyPackage, entry, identity)
    if (audit.status !== "verified") {
      throw new Error(`Final npm verification is incomplete for ${entry.name}`)
    }
    packages.push(packageEvidence(entry, { ...analyzed, audit }))
  }
  const expectedManifestSha256 = manifestSha256(sealedManifest)
  return parseNpmEvidence(
    {
      schemaVersion: 1,
      version: identity.version,
      commitSha: identity.commitSha,
      manifestSha256: expectedManifestSha256,
      complete: true,
      status: "NPM_COMPLETE",
      packages,
    },
    { candidate: identity, manifestSha256: expectedManifestSha256, manifest: sealedManifest },
  )
}

export function parsePublisherArguments(argv) {
  if (
    !Array.isArray(argv) ||
    (argv.length !== PUBLISHER_FLAGS.length * 2 && argv.length !== PUBLISHER_FLAGS.length * 2 + 2)
  ) {
    throw new Error(publisherUsage())
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !(PUBLISHER_FLAGS.includes(flag) || flag === PUBLISHER_AUTH_MODE_FLAG) ||
      typeof value !== "string" ||
      value.length === 0 ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new Error(`Invalid publisher argument\n${publisherUsage()}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate publisher argument ${flag}`)
    values.set(flag, value)
  }
  if (PUBLISHER_FLAGS.some((flag) => !values.has(flag))) throw new Error(publisherUsage())
  const npmAuthMode = values.get(PUBLISHER_AUTH_MODE_FLAG) ?? "oidc"
  if (!NPM_AUTH_MODES.includes(npmAuthMode)) {
    throw new Error(`Invalid publisher argument\n${publisherUsage()}`)
  }
  return {
    candidatePath: values.get("--candidate"),
    recordPath: values.get("--record"),
    artifactDir: values.get("--artifact-dir"),
    reportPath: values.get("--report"),
    githubOutputPath: values.get("--github-output"),
    npmAuthMode,
  }
}

export async function runPublisherCli(argv, options = {}) {
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    throw new TypeError("Publisher runtime options must be an object")
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? PUBLISHER_OVERALL_TIMEOUT_MS
  assertBoundedInteger(
    overallTimeoutMs,
    1,
    PUBLISHER_OVERALL_TIMEOUT_MS,
    "publisher overall timeout",
  )
  const deadline = createPublisherDeadline(overallTimeoutMs, {
    scheduleTimeout: options.scheduleTimeout ?? setTimeout,
    cancelTimeout: options.cancelTimeout ?? clearTimeout,
  })
  const environment = options.environment ?? process.env
  if (environment === null || Array.isArray(environment) || typeof environment !== "object") {
    deadline.dispose()
    throw new TypeError("Publisher runtime environment must be an object")
  }
  const runNpm =
    options.runNpm ??
    createReleasePreparationRunner({
      commandTimeoutMs: PUBLISH_COMMAND_TIMEOUT_MS,
      overallTimeoutMs,
    })
  const auditVerifierFactory = options.createNpmAuditVerifier ?? createNpmAuditVerifier
  if (typeof auditVerifierFactory !== "function") {
    deadline.dispose()
    throw new TypeError("npm audit verifier factory must be a function")
  }
  try {
    return await deadline.race(
      runPublisherCliWithinDeadline(argv, {
        fileSystem: options.fileSystem ?? defaultFileSystem,
        npmReader: options.npmReader,
        runNpm,
        auditVerifierFactory,
        poll: options.poll ?? productionPoll,
        log: options.log ?? productionLog,
        now: options.now ?? Date.now,
        environment,
        deadline,
      }),
    )
  } catch (error) {
    if (deadline.signal.aborted) {
      // The in-flight run may still be unwinding behind the race; release the isolated npm
      // homes (and any bootstrap credential reference) now rather than whenever it settles.
      await deadline.runCleanups()
      throw new Error("npm publisher overall deadline expired", { cause: error })
    }
    throw error
  } finally {
    deadline.dispose()
  }
}

async function runPublisherCliWithinDeadline(
  argv,
  { fileSystem, npmReader, runNpm, auditVerifierFactory, poll, log, now, environment, deadline },
) {
  const { npmAuthMode, ...inputPaths } = parsePublisherArguments(argv)
  const paths = Object.fromEntries(
    Object.entries(inputPaths).map(([key, value]) => [key, path.resolve(value)]),
  )
  const candidate = parseCandidate(
    await readBoundedRegularFile(fileSystem, paths.candidatePath, MAX_CANDIDATE_BYTES, "Candidate"),
  )
  const recordBytes = await readBoundedRegularFile(
    fileSystem,
    paths.recordPath,
    RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
    "Release record",
  )
  const record = parseReleaseRecord(recordBytes)
  if (!Buffer.from(recordBytes).equals(canonicalReleaseRecordBytes(record))) {
    throw new Error("Release record bytes must be canonical")
  }
  if (record.version !== candidate.version || record.commitSha !== candidate.commitSha) {
    throw new Error("Release record identity does not match the candidate")
  }
  const artifact = await verifyPublisherArtifact({
    artifactDir: paths.artifactDir,
    candidate,
    record,
    fileSystem,
  })
  if (npmAuthMode === "bootstrap") {
    return runBootstrapPublisher({
      candidate,
      record,
      artifact,
      paths,
      fileSystem,
      npmReader,
      runNpm,
      auditVerifierFactory,
      poll,
      log,
      now,
      environment,
      deadline,
    })
  }
  const reader = npmReader ?? createNpmReader()
  assertNpmReader(reader)
  log({ event: "npm-auth-mode", mode: "oidc" })
  const auditVerifier = await deadline.race(
    auditVerifierFactory({
      runNpm,
      fileSystem,
      environment,
      signal: deadline.signal,
      log,
    }),
  )
  try {
    for (const method of ["dispose", "publisherEnvironment", "verifyPackage"]) {
      if (typeof auditVerifier?.[method] !== "function") {
        throw new TypeError(`npm audit verifier must expose ${method}`)
      }
    }
    deadline.registerCleanup(() => auditVerifier.dispose())
    const observeRegistry = ({ name, version }) =>
      deadline.race(
        version === undefined
          ? reader.observePackageMetadata({ name, signal: deadline.signal })
          : reader.observePackageVersion({ name, version, signal: deadline.signal }),
      )
    const publishTarball = async ({ entry }) => {
      const tarballPath = artifact.tarballPaths.get(entry.name)
      if (tarballPath === undefined) throw new Error("Recorded tarball path is unavailable")
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
      await runNpm(
        "npm",
        [
          "publish",
          tarballPath,
          "--tag",
          "latest",
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
        ],
        {
          cwd: paths.artifactDir,
          env: auditVerifier.publisherEnvironment({ candidate }),
          signal: deadline.signal,
        },
      )
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
    }
    const result = await publishManifestSerially({
      candidate,
      manifest: artifact.manifest,
      observeRegistry,
      downloadRegistryTarball: (request) =>
        deadline.race(reader.downloadRegistryTarball({ ...request, signal: deadline.signal })),
      verifyPackage: (request) => deadline.race(auditVerifier.verifyPackage(request)),
      publishTarball,
      poll: (request) => deadline.race(poll({ ...request, signal: deadline.signal })),
      log,
      now,
    })
    await writeCanonicalReport({
      fileSystem,
      reportPath: paths.reportPath,
      result,
      candidate,
      manifest: artifact.manifest,
    })
    await fileSystem.appendFile(
      paths.githubOutputPath,
      `complete=${String(result.complete)}\nstate=${result.status}\n`,
      "utf8",
    )
    return result
  } finally {
    if (typeof auditVerifier?.dispose === "function") await auditVerifier.dispose()
  }
}

// The first-publication exception. Everything before this point (candidate, canonical record,
// sealed manifest, local tarballs) has already been verified exactly as in OIDC mode. This path
// additionally requires the owner-managed, candidate-bound, expiring authorization and the
// dedicated token before any npm process starts; it then publishes through the same serial
// publisher with the explicitly selected first-publication reader.
async function runBootstrapPublisher({
  candidate,
  record,
  artifact,
  paths,
  fileSystem,
  npmReader,
  runNpm,
  auditVerifierFactory,
  poll,
  log,
  now,
  environment,
  deadline,
}) {
  const bound = validateBootstrapAuthorization(
    parseBootstrapAuthorization(environment[BOOTSTRAP_AUTHORIZATION_VARIABLE]),
    { candidate, manifest: artifact.manifest, record, environment },
  )
  const authorization = bound.authorization
  assertBootstrapWindow(authorization, now())
  const token = validateBootstrapToken(environment[BOOTSTRAP_TOKEN_VARIABLE])
  const reader =
    npmReader === undefined
      ? createFirstPublicationNpmReader()
      : adaptFirstPublicationNpmReader(npmReader)
  assertNpmReader(reader)
  log({
    event: "npm-auth-mode",
    mode: "bootstrap",
    authorizationSha256: bound.authorizationSha256,
    version: authorization.version,
    commitSha: authorization.commitSha,
    notBefore: authorization.notBefore,
    expiresAt: authorization.expiresAt,
  })
  const redactedRunNpm = async (command, args, options) => {
    let result
    try {
      result = await runNpm(command, args, options)
    } catch (error) {
      throw redactBootstrapError(error, token)
    }
    return result === null || typeof result !== "object"
      ? result
      : {
          ...result,
          ...(typeof result.stdout === "string"
            ? { stdout: redactBootstrapCredential(result.stdout, token) }
            : {}),
          ...(typeof result.stderr === "string"
            ? { stderr: redactBootstrapCredential(result.stderr, token) }
            : {}),
        }
  }
  let auditVerifier
  try {
    auditVerifier = await deadline.race(
      auditVerifierFactory({
        runNpm: redactedRunNpm,
        fileSystem,
        environment,
        signal: deadline.signal,
        log,
        bootstrap: { token },
      }),
    )
    for (const method of ["dispose", "publisherEnvironment", "verifyPackage"]) {
      if (typeof auditVerifier?.[method] !== "function") {
        throw new TypeError(`npm audit verifier must expose ${method}`)
      }
    }
    deadline.registerCleanup(() => auditVerifier.dispose())
    const observeRegistry = ({ name, version }) =>
      deadline.race(
        version === undefined
          ? reader.observePackageMetadata({
              name,
              version: candidate.version,
              signal: deadline.signal,
            })
          : reader.observePackageVersion({ name, version, signal: deadline.signal }),
      )
    const publishTarball = async ({ entry }) => {
      const tarballPath = artifact.tarballPaths.get(entry.name)
      if (tarballPath === undefined) throw new Error("Recorded tarball path is unavailable")
      // The window is re-checked immediately before every publish spawn. Expiry between
      // packages stops further mutation; a replacement window for the same candidate resumes.
      assertBootstrapWindow(authorization, now())
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
      await redactedRunNpm(
        "npm",
        [
          "publish",
          tarballPath,
          "--tag",
          "latest",
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
        ],
        {
          cwd: paths.artifactDir,
          env: auditVerifier.publisherEnvironment({ candidate }),
          signal: deadline.signal,
        },
      )
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
    }
    const result = await publishManifestSerially({
      candidate,
      manifest: artifact.manifest,
      observeRegistry,
      downloadRegistryTarball: (request) =>
        deadline.race(reader.downloadRegistryTarball({ ...request, signal: deadline.signal })),
      verifyPackage: (request) => deadline.race(auditVerifier.verifyPackage(request)),
      publishTarball,
      poll: (request) => deadline.race(poll({ ...request, signal: deadline.signal })),
      log,
      now,
      firstPublication: true,
    })
    await writeCanonicalReport({
      fileSystem,
      reportPath: paths.reportPath,
      result,
      candidate,
      manifest: artifact.manifest,
    })
    await fileSystem.appendFile(
      paths.githubOutputPath,
      `complete=${String(result.complete)}\nstate=${result.status}\n`,
      "utf8",
    )
    return result
  } catch (error) {
    throw redactBootstrapError(error, token)
  } finally {
    if (typeof auditVerifier?.dispose === "function") await auditVerifier.dispose()
  }
}

async function waitUntilVerified({
  entry,
  candidate,
  observeRegistry,
  observeMetadata,
  downloadRegistryTarball,
  verifyPackage,
  poll,
  log,
  now,
}) {
  let attempt = 0
  const startedAt = now()
  for (;;) {
    attempt += 1
    // A package published for the first time is not immediately readable: its
    // packument can still answer not-found for a short window. That is the same
    // convergence this loop already waits out for tarballs and versions, so it
    // is polled rather than treated as a verification failure. Any other
    // ambiguity still fails, and the deadline below still bounds the wait.
    let metadata
    try {
      metadata = await observeMetadata(observeRegistry, entry.name)
    } catch (error) {
      const elapsed = Math.max(0, now() - startedAt)
      if (elapsed >= TARBALL_CONVERGENCE_DEADLINE_MS) throw error
      log({
        event: "registry-pending",
        name: entry.name,
        reason: "metadata-pending",
        attempt,
        elapsedMs: elapsed,
        delayMs: POLL_DELAY_MS,
        deadlineMs: TARBALL_CONVERGENCE_DEADLINE_MS,
      })
      await poll({ name: entry.name, attempt, delayMs: POLL_DELAY_MS })
      continue
    }
    const latest = metadata.metadata.latest
    if (latest !== null && compareSemver(latest, candidate.version) > 0) {
      failNewerLatest(entry.name)
    }
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate,
      downloadRegistryTarball,
    })
    let reason =
      analyzed.status === "tarball-pending"
        ? "tarball-404"
        : analyzed.status === "absent"
          ? "version-absent"
          : "metadata-pending"
    if (analyzed.status === "present" && registryReady(analyzed, candidate)) {
      const audit = await observeNpmAudit(verifyPackage, entry, candidate)
      if (audit.status === "verified") return { ...analyzed, audit, ready: true }
      reason = "audit-pending"
    }
    const elapsedMs = Math.max(0, now() - startedAt)
    const delayMs =
      attempt <= TARBALL_FAST_POLL_ATTEMPTS ? POLL_DELAY_MS : TARBALL_SLOW_POLL_DELAY_MS
    log({
      event: reason === "tarball-404" ? "registry-tarball-pending" : "registry-pending",
      name: entry.name,
      reason,
      attempt,
      elapsedMs,
      delayMs,
      deadlineMs: TARBALL_CONVERGENCE_DEADLINE_MS,
      ...(reason === "tarball-404" ? { httpStatus: analyzed.download.httpStatus } : {}),
    })
    if (elapsedMs >= TARBALL_CONVERGENCE_DEADLINE_MS) {
      throw new Error(
        reason === "tarball-404"
          ? `npm registry tarball could not be verified for ${entry.name}`
          : `npm registry did not converge for ${entry.name}`,
      )
    }
    await poll({ name: entry.name, attempt, delayMs })
  }
}

function isPublished(analyzed) {
  return analyzed.status === "present" || analyzed.status === "tarball-pending"
}

async function sweepLatest({ manifest, observeRegistry, observeMetadata }) {
  // Only metadata reads are concurrent; callers still gate publication mutations.
  return Promise.all(
    manifest.packages.map(async (entry) => ({
      entry,
      metadata: await observeMetadata(observeRegistry, entry.name),
    })),
  )
}

async function observePackageMetadata(observeRegistry, name, { firstPublication }) {
  const result = await observeRegistry({ name })
  if (
    firstPublication &&
    result !== null &&
    typeof result === "object" &&
    result.status === "ABSENT" &&
    result.operation === "package-metadata" &&
    result.httpStatus === 404 &&
    result.code === "E404" &&
    Object.keys(result).length === 4
  ) {
    // The first-publication reader proved the whole package absent from both trusted public
    // not-found endpoints. Carry it in the publisher's internal latest representation; the
    // status stays ABSENT, never a fabricated present observation.
    return deepFreeze({ ...result, metadata: { name, latest: null } })
  }
  if (
    result?.status !== "PRESENT" ||
    result.operation !== "package-metadata" ||
    result.metadata?.name !== name ||
    !(
      result.metadata.latest === null ||
      (isExactSemver(result.metadata.latest) &&
        parseSemver(result.metadata.latest).build.length === 0)
    )
  ) {
    throw new Error(`npm metadata observation is ambiguous or unverified for ${name}`)
  }
  return result
}

async function observeVersion(observeRegistry, entry) {
  const result = await observeRegistry({ name: entry.name, version: entry.version })
  if (
    result?.status === "ABSENT" &&
    result.operation === "package-version" &&
    result.httpStatus === 404 &&
    result.code === "E404"
  ) {
    return result
  }
  if (result?.status !== "PRESENT" || result.operation !== "package-version") {
    throw new Error(`npm exact-version observation is ambiguous or unverified for ${entry.name}`)
  }
  return result
}

async function analyzeVersion({ entry, metadata, version, downloadRegistryTarball }) {
  if (version.status === "ABSENT") {
    return { status: "absent", entry, metadata }
  }
  const packageRecord = version.package
  if (
    packageRecord === null ||
    typeof packageRecord !== "object" ||
    packageRecord.name !== entry.name ||
    packageRecord.version !== entry.version ||
    typeof packageRecord.tarballUrl !== "string" ||
    packageRecord.integrity !== entry.npmIntegrity ||
    packageRecord.distTags?.latest !== packageRecord.latest
  ) {
    throw new Error(`npm package identity or integrity conflicts for ${entry.name}`)
  }
  const download = await downloadRegistryTarball({ tarballUrl: packageRecord.tarballUrl })
  if (isTarballPending(download)) {
    return { status: "tarball-pending", entry, metadata, package: packageRecord, download }
  }
  if (
    download?.status !== "PRESENT" ||
    download.operation !== "package-tarball" ||
    download.tarball?.url !== packageRecord.tarballUrl
  ) {
    throw new Error(`npm registry tarball could not be verified for ${entry.name}`)
  }
  const tarball = verifyDownloadedTarball(download.tarball, entry)
  if (packageRecord.shasum !== tarball.sha1) {
    throw new Error(`npm registry tarball shasum conflicts for ${entry.name}`)
  }
  return {
    status: "present",
    entry,
    metadata,
    package: packageRecord,
    tarball,
  }
}

// The npm adapter classifies a tarball 404 as AMBIGUOUS/HTTP_404 (a binary body carries
// no registry error code) rather than ABSENT; both shapes mean "not propagated yet".
function isTarballPending(download) {
  return (
    download !== null &&
    typeof download === "object" &&
    download.operation === "package-tarball" &&
    download.httpStatus === 404 &&
    (download.status === "ABSENT" || download.status === "AMBIGUOUS")
  )
}

function registryReady(analyzed, candidate) {
  return (
    analyzed.metadata.metadata.latest === candidate.version &&
    analyzed.package.latest === candidate.version
  )
}

async function observeNpmAudit(verifyPackage, entry, candidate) {
  const result = await verifyPackage({ entry, candidate })
  if (result?.status === "pending" && Object.keys(result).length === 1) return result
  if (
    result?.status !== "verified" ||
    result.signature?.status !== "valid" ||
    result.signature?.verifier !== "npm-audit-signatures@11.17.0" ||
    result.provenance?.predicateType !== "https://slsa.dev/provenance/v1" ||
    result.provenance.workflow !== candidate.publisherWorkflow ||
    result.provenance.commitSha !== candidate.commitSha ||
    result.provenance.repository !== EXPECTED_REPOSITORY ||
    result.provenance.ref !== `refs/tags/v${candidate.version}`
  ) {
    throw new Error(`Official npm audit evidence is invalid for ${entry.name}`)
  }
  return result
}

function verifyDownloadedTarball(value, entry) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.contentBase64 !== "string" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !/^[0-9a-f]{40}$/u.test(value.sha1) ||
    !SHA256_PATTERN.test(value.sha256) ||
    !SHA512_PATTERN.test(value.sha512)
  ) {
    throw new Error(`npm registry tarball response is malformed for ${entry.name}`)
  }
  const bytes = Buffer.from(value.contentBase64, "base64")
  if (
    bytes.toString("base64") !== value.contentBase64 ||
    bytes.length !== value.size ||
    bytes.length !== entry.size ||
    digest(bytes, "sha1") !== value.sha1 ||
    digest(bytes, "sha256") !== value.sha256 ||
    digest(bytes, "sha512") !== value.sha512 ||
    value.sha256 !== entry.sha256 ||
    value.sha512 !== entry.sha512
  ) {
    throw new Error(`npm registry tarball bytes or digest do not match ${entry.name}`)
  }
  return value
}

function packageEvidence(entry, analyzed) {
  return deepFreeze({
    name: entry.name,
    version: entry.version,
    status: "present",
    size: entry.size,
    tarballSha256: entry.sha256,
    tarballSha512: entry.sha512,
    integrity: entry.npmIntegrity,
    latest: { status: "present", version: entry.version },
    signature: {
      status: "valid",
      verifier: analyzed.audit.signature.verifier,
    },
    provenance: {
      predicateType: analyzed.audit.provenance.predicateType,
      workflow: analyzed.audit.provenance.workflow,
      commitSha: analyzed.audit.provenance.commitSha,
      repository: analyzed.audit.provenance.repository,
      ref: analyzed.audit.provenance.ref,
    },
  })
}

async function verifyPublisherArtifact({ artifactDir, candidate, record, fileSystem }) {
  const canonicalDir = await fileSystem.realpath(artifactDir)
  if (canonicalDir !== artifactDir) throw new Error("Artifact directory must be canonical")
  const manifestPath = path.join(artifactDir, "manifest.json")
  const manifestBytes = await readBoundedRegularFile(
    fileSystem,
    manifestPath,
    RELEASE_PAYLOAD_LIMITS.manifestBytes,
    "Release manifest",
  )
  const manifest = parseSealedReleaseManifest(manifestBytes, { candidate })
  if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes(manifest))) {
    throw new Error("Release manifest bytes must be canonical")
  }
  if (manifestSha256(manifest) !== record.manifestSha256) {
    throw new Error("Release manifest digest does not match the release record")
  }
  const expected = ["manifest.json", ...manifest.packages.map((entry) => entry.filename)].sort()
  const actual = (await fileSystem.readdir(artifactDir)).sort()
  if (!arraysEqual(actual, expected)) {
    throw new Error("Artifact directory file set does not match the release manifest")
  }
  const tarballPaths = new Map()
  for (const entry of manifest.packages) {
    const tarballPath = path.join(artifactDir, entry.filename)
    await verifyLocalTarball({ entry, tarballPath, fileSystem })
    tarballPaths.set(entry.name, tarballPath)
  }
  return { manifest, tarballPaths }
}

async function verifyLocalTarball({ entry, tarballPath, fileSystem }) {
  const bytes = await readBoundedRegularFile(
    fileSystem,
    tarballPath,
    RELEASE_PAYLOAD_LIMITS.tarballBytes,
    `${entry.name} tarball`,
  )
  if (
    bytes.length !== entry.size ||
    digest(bytes, "sha256") !== entry.sha256 ||
    digest(bytes, "sha512") !== entry.sha512
  ) {
    throw new Error(`${entry.name} local tarball does not match the release manifest`)
  }
}

async function readBoundedRegularFile(fileSystem, target, maximumBytes, label) {
  const before = await fileSystem.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1) {
    throw new Error(`${label} must be one positive regular file`)
  }
  assertPayloadByteLength(before.size, maximumBytes, label)
  const bytes = await fileSystem.readFile(target)
  assertPayloadByteLength(bytes.byteLength, maximumBytes, label)
  const after = await fileSystem.lstat(target)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.size !== before.size ||
    after.size !== bytes.byteLength ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error(`${label} changed while being read`)
  }
  return Buffer.from(bytes)
}

async function writeCanonicalReport({ fileSystem, reportPath, result, candidate, manifest }) {
  const bytes =
    result.status === "NPM_COMPLETE"
      ? canonicalNpmEvidenceBytes(result, {
          candidate,
          manifestSha256: manifestSha256(manifest),
          manifest,
        })
      : Buffer.from(`${JSON.stringify(canonicalize(result), null, 2)}\n`, "utf8")
  assertPayloadByteLength(bytes.length, NPM_EVIDENCE_MAX_BYTES, "npm publication report")
  try {
    const existing = await readBoundedRegularFile(
      fileSystem,
      reportPath,
      NPM_EVIDENCE_MAX_BYTES,
      "npm publication report",
    )
    if (!existing.equals(bytes)) throw new Error("Existing npm publication report conflicts")
    return
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const temporary = `${reportPath}.tmp-${process.pid}`
  try {
    await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await fileSystem.rename(temporary, reportPath)
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => undefined)
    throw error
  }
}

function parseCandidate(raw) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
  } catch (error) {
    throw new TypeError("Candidate JSON is invalid", { cause: error })
  }
  return validateCandidate(value)
}

function validateCandidate(candidate) {
  const value = snapshotJson(candidate)
  assertExactFields(value, CANDIDATE_FIELDS, "candidate")
  if (
    !isReleaseVersion(value.version) ||
    !SHA_PATTERN.test(value.commitSha) ||
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Candidate identity or release policy is invalid")
  }
  return deepFreeze(value)
}

function newerLatest(observations, candidateVersion) {
  for (const observation of observations) {
    const metadata = observation.metadata ?? observation
    const latest = metadata.metadata.latest
    const entry = observation.entry ?? { name: observation.package?.name }
    if (latest !== null && compareSemver(latest, candidateVersion) > 0) {
      return { name: entry.name }
    }
  }
  return null
}

function failNewerLatest(name) {
  throw new Error(`A newer latest tag conflicts with partial candidate state at ${name}`)
}

function supersededResult(candidate, manifest) {
  return deepFreeze({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: manifestSha256(manifest),
    complete: false,
    status: "SUPERSEDED_NOOP",
    packages: [],
  })
}

async function productionPoll({ delayMs, signal }) {
  if (signal?.aborted === true) throw new Error("npm publisher poll was aborted")
  await new Promise((resolvePromise, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error("npm publisher poll was aborted"))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolvePromise()
    }, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
  })
}

function productionLog(event) {
  console.log(JSON.stringify(event))
}

function assertNpmReader(value) {
  for (const method of [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`npm reader must expose ${method}`)
    }
  }
}

function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`)
}

function createPublisherDeadline(timeoutMs, { scheduleTimeout, cancelTimeout }) {
  if (typeof scheduleTimeout !== "function" || typeof cancelTimeout !== "function") {
    throw new TypeError("publisher deadline scheduler is invalid")
  }
  const controller = new AbortController()
  let rejectExpiration
  const expiration = new Promise((_resolve, reject) => {
    rejectExpiration = reject
  })
  const timer = scheduleTimeout(() => {
    controller.abort()
    rejectExpiration(new Error("npm publisher overall deadline expired"))
  }, timeoutMs)
  // Keep the expiration rejection observed even when no race is pending.
  expiration.catch(() => undefined)
  const cleanups = []
  return {
    signal: controller.signal,
    race(value) {
      return Promise.race([Promise.resolve(value), expiration])
    },
    registerCleanup(cleanup) {
      cleanups.push(cleanup)
    },
    async runCleanups() {
      for (const cleanup of cleanups.splice(0)) {
        try {
          await cleanup()
        } catch {
          // Deadline failure is already the reported error; cleanup is best effort here.
        }
      }
    },
    dispose() {
      cancelTimeout(timer)
    },
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function assertExactFields(value, fields, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} is missing ${field}`)
  }
  const extra = Object.keys(value).filter((field) => !fields.includes(field))
  if (extra.length > 0) throw new TypeError(`${label} contains unknown field ${extra.sort()[0]}`)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function publisherUsage() {
  return "Usage: node scripts/release/publisher.mjs --candidate <candidate.json> --record <release-record.json> --artifact-dir <directory> --report <publish.json> --github-output <path> [--npm-auth-mode oidc|bootstrap]"
}
