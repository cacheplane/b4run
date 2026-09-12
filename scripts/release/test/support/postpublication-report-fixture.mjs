import { createHash } from "node:crypto"
import { CANONICAL_RELEASE_PACKAGE_ORDER, manifestSha256 } from "../../manifest.mjs"
import { canonicalNpmEvidenceBytes } from "../../npm-evidence.mjs"
import { canonicalReleaseRecordBytes, releaseRecordSha256 } from "../../release-record.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const CANDIDATE = {
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
}

export function postpublicationReportFixture({ state, transition, npm = false, audit = false }) {
  const manifest = releaseManifest()
  const releaseRecord = recordFor(manifest)
  const npmEvidence = npm ? npmEvidenceFor(manifest) : null
  const auditDispatch = audit
    ? {
        workflow: ".github/workflows/published-artifact-verify.yml",
        workflowRunId: 500,
        runUrl: "https://api.github.com/repos/cacheplane/b4run/actions/runs/500",
        htmlUrl: "https://github.com/cacheplane/b4run/actions/runs/500",
      }
    : null
  const auditResult = audit
    ? {
        schemaVersion: 1,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: manifestSha256(manifest),
        workflowRunId: 500,
        runAttempt: 1,
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:10:00.000Z",
        conclusion: "success",
        checks: [{ name: "release", conclusion: "success", detail: "verified" }],
      }
    : null
  return {
    schemaVersion: 1,
    candidate: structuredClone(CANDIDATE),
    before: {
      observation: {
        artifacts: {
          manifestSha256: manifestSha256(manifest),
          releaseRecordAsset: { sha256: releaseRecordSha256(releaseRecord) },
        },
      },
      plan: {
        state,
        disposition: "would-transition",
        nextTransition: transition,
        reasons: [`release state is ready for ${transition}`],
        conflicts: [],
        proposedMutations: [{ type: transition, version: VERSION, commitSha: COMMIT_SHA }],
      },
    },
    transition: {
      name: transition,
      status: "dry-run",
      result: null,
      error: null,
    },
    after: null,
    recovery: {
      schemaVersion: 1,
      candidate: structuredClone(CANDIDATE),
      manifest,
      releaseRecord,
      npmEvidence,
      auditDispatch,
      auditResult,
    },
    diagnostics: [],
  }
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name, index) => packageEntry(name, index)),
  }
}

function packageEntry(name, index) {
  const bytes = Buffer.from(`packed:${name}`)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
  return {
    name,
    version: VERSION,
    filename: `${stem}-${VERSION}.tgz`,
    size: bytes.length + index,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function recordFor(manifest) {
  return JSON.parse(
    canonicalReleaseRecordBytes({
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      tag: `v${VERSION}`,
      manifestSha256: manifestSha256(manifest),
      actionsArtifact: {
        id: "123456789",
        name: manifest.artifact.name,
        serviceDigest: `sha256:${"a".repeat(64)}`,
        prepareRunId: "200",
        prepareRunAttempt: 1,
      },
    }),
  )
}

function npmEvidenceFor(manifest) {
  return JSON.parse(
    canonicalNpmEvidenceBytes(
      {
        schemaVersion: 1,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: manifestSha256(manifest),
        complete: true,
        status: "NPM_COMPLETE",
        packages: manifest.packages.map((entry) => ({
          name: entry.name,
          version: VERSION,
          status: "present",
          size: entry.size,
          tarballSha256: entry.sha256,
          tarballSha512: entry.sha512,
          integrity: entry.npmIntegrity,
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
      },
      {
        candidate: CANDIDATE,
        manifest,
        manifestSha256: manifestSha256(manifest),
      },
    ),
  )
}
