// Frozen pre-handoff bytes; all post-NPM phase transitions run through production modules.
import { createHash } from "node:crypto"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../../manifest.mjs"
import { canonicalBaseAssetSet } from "../../metadata.mjs"
import { createReleaseRecord, releaseRecordSha256 } from "../../release-record.mjs"
export const VERSION = "0.8.27"
export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
export const CANDIDATE = {
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
}
const REPOSITORY = "cacheplane/b4run"
function releaseFixture({
  bundleText = "multi-subject-bundle",
  attestationRunId = 100,
  attestationRunAttempt = 2,
} = {}) {
  const fileBytes = new Map()
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const filename = packageFilename(name)
    const bytes = Buffer.from(`package:${name}:${VERSION}`, "utf8")
    fileBytes.set(filename, bytes)
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    return {
      name,
      version: VERSION,
      filename,
      size: bytes.length,
      sha256: sha256(bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 10, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 11,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
  const manifestBytes = canonicalManifestBytes(manifest)
  fileBytes.set("manifest.json", manifestBytes)
  const record = createReleaseRecord({
    candidate: CANDIDATE,
    manifestSha256: sha256(manifestBytes),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: "12", digest: `sha256:${"a".repeat(64)}` },
    prepareRun: { id: 11, attempt: 1 },
  })
  const subjectFiles = [
    { name: "manifest.json", bytes: manifestBytes },
    ...packages.map((pkg) => ({
      name: pkg.filename,
      bytes: fileBytes.get(pkg.filename),
    })),
  ]
  const bundleBytes = attestationBundleBytes(subjectFiles, {
    runId: attestationRunId,
    runAttempt: attestationRunAttempt,
    signature: bundleText,
  })
  const bundles = subjectFiles.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: Buffer.from(bundleBytes),
  }))
  const attestationSet = {
    repository: REPOSITORY,
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: attestationRunId,
    runAttempt: attestationRunAttempt,
    subjects: subjectFiles.map((file, index) => ({
      subjectName: file.name,
      subjectSha256: sha256(file.bytes),
      bundleName: bundles[index].name,
      bundleSha256: sha256(bundles[index].bytes),
    })),
  }
  return {
    manifest,
    record,
    attestationSet,
    bundles,
    artifact: { manifest, files: subjectFiles },
  }
}

function attestationBundleBytes(subjectFiles, { runId, runAttempt, signature }) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjectFiles.map((file) => ({
      name: file.name,
      digest: { sha256: sha256(file.bytes) },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      runDetails: {
        metadata: {
          invocationId: `https://github.com/cacheplane/b4run/actions/runs/${runId}/attempts/${runAttempt}`,
        },
      },
    },
  }
  return Buffer.from(
    JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        signatures: [{ sig: Buffer.from(signature, "utf8").toString("base64") }],
      },
      verificationMaterial: {},
    }),
    "utf8",
  )
}

function escrowMarker(fixture) {
  const base = canonicalBaseAssetSet({
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
  })
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: sha256(canonicalManifestBytes(fixture.manifest)),
    releaseRecordSha256: releaseRecordSha256(fixture.record),
    baseAssetSetSha256: base.sha256,
    attestationSet: fixture.attestationSet,
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
}

function packageFilename(name) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`
}

function completeNpmEvidence(fixture) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
    status: "NPM_COMPLETE",
    packages: fixture.manifest.packages.map((pkg) => ({
      name: pkg.name,
      version: VERSION,
      status: "present",
      size: pkg.size,
      tarballSha256: pkg.sha256,
      tarballSha512: pkg.sha512,
      integrity: pkg.npmIntegrity,
      latest: { status: "present", version: VERSION },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: ".github/workflows/release.yml",
        commitSha: COMMIT_SHA,
        repository: "https://github.com/cacheplane/b4run",
        ref: `refs/tags/v${VERSION}`,
      },
    })),
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    bytes.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

export { completeNpmEvidence, escrowMarker, releaseFixture, sha256, zip }
