import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import * as historical from "../historical-publication.mjs"
import { parseHistoricalPublicationRecord } from "../historical-publication-record.mjs"
import { canonicalReleaseBody } from "../metadata.mjs"
import { NPM_AUDIT_VERIFIER, parseHistoricalNpmAuditResult } from "../npm-audit.mjs"
import { planRelease } from "../planner.mjs"
import { RELEASE_PROGRESS_RANK } from "../state.mjs"
import {
  TEST_CANDIDATE,
  TEST_MANIFEST,
  TEST_OFFICIAL_AUDIT,
  TEST_RECEIPT,
  testRecord,
} from "./fixtures/historical-0155.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

// Public original publisher ZIP, retained solely as test evidence, never as a production admission record.
test("original publisher archive authenticates the service digest and canonical original receipt", async () => {
  const archive = await readFile(
    new URL("./fixtures/historical-0155-npm-evidence.zip", import.meta.url),
  )
  const record = testRecord()
  record.original.artifact.size = archive.length
  record.supportingEvidence.find((file) => file.path.endsWith(".zip")).size = archive.length
  const admitted = parseHistoricalPublicationRecord(record, { manifest: TEST_MANIFEST })

  const result = historical.authenticateOriginalNpmArchive(archive, {
    record: admitted,
    manifest: TEST_MANIFEST,
  })

  assert.deepEqual(result.npmEvidence, TEST_RECEIPT)
  assert.equal(result.archiveSha256, admitted.original.artifact.sha256)
  assert.equal(result.receiptSha256, admitted.incident.originalReceiptSha256)
  const altered = Buffer.from(archive)
  altered[0] ^= 1
  assert.throws(() =>
    historical.authenticateOriginalNpmArchive(altered, {
      record: admitted,
      manifest: TEST_MANIFEST,
    }),
  )
})

test("fresh original authentication binds complete run/jobs, Git support, archive and exact audit assets", async () => {
  const input = await originalFixture()

  const result = await historical.authenticateHistoricalOriginalEvidence(input)

  assert.deepEqual(result.publisher, input.record.original.publisher)
  assert.deepEqual(result.audit, input.record.original.audit)
  assert.equal(result.archiveSha256, input.record.original.artifact.sha256)
  assert.equal(result.receiptSha256, input.record.incident.originalReceiptSha256)
})

for (const [name, mutate] of [
  [
    "publisher missing",
    (input) => {
      input.github.getActionsRun = async () => absent("actions-run")
    },
  ],
  [
    "publisher repo numeric ID",
    (input) => {
      input.runs[0].repository.id++
    },
  ],
  [
    "publisher attempt",
    (input) => {
      input.runs[0].run_attempt++
    },
  ],
  [
    "publisher ref",
    (input) => {
      input.runs[0].head_branch = "main"
    },
  ],
  [
    "publisher SHA",
    (input) => {
      input.runs[0].head_sha = "1".repeat(40)
    },
  ],
  [
    "publisher workflow",
    (input) => {
      input.runs[0].path = ".github/workflows/foreign.yml"
    },
  ],
  [
    "publisher unsuccessful",
    (input) => {
      input.runs[0].conclusion = "failure"
    },
  ],
  [
    "publisher job missing",
    (input) => {
      input.jobs[0] = []
    },
  ],
  [
    "publisher job unsuccessful",
    (input) => {
      input.jobs[0][0].conclusion = "failure"
    },
  ],
  [
    "publisher extra job",
    (input) => {
      input.jobs[0].push({ ...input.jobs[0][0], id: 999, name: "other" })
    },
  ],
  [
    "audit missing",
    (input) => {
      input.runs[1].status = "in_progress"
    },
  ],
  [
    "audit job source",
    (input) => {
      input.jobs[1][0].head_sha = "2".repeat(40)
    },
  ],
  [
    "artifact name",
    (input) => {
      input.artifact.name = "other"
    },
  ],
  [
    "artifact digest",
    (input) => {
      input.artifact.digest = `sha256:${"2".repeat(64)}`
    },
  ],
  [
    "audit asset ID",
    (input) => {
      input.assets[0].id++
    },
  ],
  [
    "audit asset size",
    (input) => {
      input.assets[0].size++
    },
  ],
  [
    "support symlink",
    (input) => {
      input.mode = "120000"
    },
  ],
  [
    "support digest",
    (input) => {
      input.files.set(input.record.original.artifact.path, Buffer.from("wrong"))
    },
  ],
]) {
  test(`original authentication rejects ${name}`, async () => {
    const input = await originalFixture()
    mutate(input)

    await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
  })
}

test("only authenticated captured expiry permits original archive fallback; mutable runs remain fresh", async () => {
  const input = await originalFixture()
  input.github.getActionsArtifact = async () => absent("actions-artifact")
  input.github.listActionsRunArtifacts = async () => present("actions-run-artifacts", [])

  assert.equal(
    (await historical.authenticateHistoricalOriginalEvidence(input)).receiptSha256,
    input.record.incident.originalReceiptSha256,
  )
  input.runs[1].conclusion = "failure"
  await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
})

test("arbitrary artifact 404 before proven expiry never permits retained archive fallback", async () => {
  const input = await originalFixture({ expired: false })
  input.github.getActionsArtifact = async () => absent("actions-artifact")
  input.github.listActionsRunArtifacts = async () => present("actions-run-artifacts", [])

  await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
})

async function originalFixture({ expired = true } = {}) {
  const archive = await readFile(
    new URL("./fixtures/historical-0155-npm-evidence.zip", import.meta.url),
  )
  const record = testRecord(),
    prefix = "scripts/release/historical-publications/evidence/v0.15.5/"
  record.original.artifact.size = archive.length
  const files = new Map([
    [record.original.artifact.path, archive],
    [`${prefix}npm-evidence.json`, Buffer.from(`${JSON.stringify(TEST_RECEIPT, null, 2)}\n`)],
    ...record.original.audit.receipts.map((asset) => [
      `${prefix}${asset.name}`,
      Buffer.from(`${JSON.stringify(asset.receipt, null, 2)}\n`),
    ]),
    [`${prefix}bracket-before.json`, Buffer.from("bracket\n")],
    [`${prefix}bracket-after.json`, Buffer.from("bracket\n")],
    [`${prefix}sweep-first.json`, Buffer.from("first\n")],
    [`${prefix}sweep-second.json`, Buffer.from("second\n")],
    [
      `${prefix}original-artifact.json`,
      Buffer.from(
        `${JSON.stringify({
          id: record.original.artifact.id,
          name: record.original.artifact.name,
          runId: record.original.artifact.runId,
          headSha: record.incident.commitSha,
          serviceDigest: record.original.artifact.serviceDigest,
          size: archive.length,
          expired,
          expiresAt: expired ? "2026-10-27T11:00:00.000Z" : "2099-10-27T11:00:00.000Z",
          observedAt: record.capture.startedAt,
        })}\n`,
      ),
    ],
  ])
  record.brackets.forEach((bracket) => {
    bracket.factsSha256 = hash(Buffer.from("bracket\n"))
  })
  record.sweeps[0].evidenceSha256 = hash(Buffer.from("first\n"))
  record.sweeps[1].evidenceSha256 = hash(Buffer.from("second\n"))
  record.supportingEvidence = [...files]
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
  const runs = [record.original.publisher, record.original.audit.run].map((run) => ({
    id: run.runId,
    run_attempt: run.runAttempt,
    repository: { id: run.repositoryId, full_name: run.repository },
    path: run.workflow,
    head_branch: "v0.15.5",
    head_sha: run.commitSha,
    status: run.status,
    conclusion: run.conclusion,
  }))
  const jobs = [record.original.publisher, record.original.audit.run].map((run) =>
    run.jobs.map((job) => ({
      ...job,
      runAttempt: 1,
      run_id: run.runId,
      head_sha: run.commitSha,
      startedAt: "2026-10-26T12:00:00.000Z",
      completedAt: "2026-10-26T12:01:00.000Z",
    })),
  )
  const artifact = {
    id: record.original.artifact.id,
    name: record.original.artifact.name,
    digest: record.original.artifact.serviceDigest,
    size_in_bytes: archive.length,
    expired: false,
    workflow_run: { id: record.original.artifact.runId, head_sha: record.incident.commitSha },
  }
  const assets = record.original.audit.receipts.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    digest: `sha256:${asset.sha256}`,
  }))
  const input = {
    manifest: TEST_MANIFEST,
    record: parseHistoricalPublicationRecord(record, { manifest: TEST_MANIFEST }),
    ref: "a".repeat(40),
    files,
    runs,
    jobs,
    artifact,
    assets,
    mode: "100644",
  }
  input.git = {
    listTreeEntries: async () =>
      [...files.keys()].map((path) => `${input.mode} blob ${"b".repeat(40)}\t${path}\0`).join(""),
    showFileBytes: async ({ path }) => files.get(path),
  }
  input.github = {
    getRef: async () =>
      present("ref", {
        ref: record.incident.publisherRef,
        object: { type: "tag", sha: input.tagObjectSha ?? record.incident.tagObjectSha },
      }),
    getGitTag: async () =>
      present("git-tag", {
        sha: record.incident.tagObjectSha,
        tag: record.incident.tag,
        object: { type: "commit", sha: record.incident.commitSha },
      }),
    getActionsRun: async ({ runId }) =>
      present(
        "actions-run",
        runs.find((run) => run.id === runId),
      ),
    getActionsRunAttempt: async ({ runId }) =>
      present(
        "actions-run-attempt",
        runs.find((run) => run.id === runId),
      ),
    listActionsRunJobsComplete: async ({ runId }) =>
      present("actions-run-jobs-complete", jobs[runs.findIndex((run) => run.id === runId)]),
    getActionsArtifact: async () => present("actions-artifact", artifact),
    listActionsRunArtifacts: async () => present("actions-run-artifacts", [artifact]),
    downloadActionsArtifact: async () => binary("actions-artifact-download", archive),
    getRelease: async () =>
      present("release", {
        id: record.incident.releaseId,
        tag_name: record.incident.tag,
        immutable: true,
        draft: false,
        body: "retained release body",
      }),
    listReleaseAssets: async () => present("release-assets", assets),
    downloadReleaseAsset: async ({ assetId }) =>
      binary(
        "release-asset-download",
        files.get(`${prefix}${assets.find((asset) => asset.id === assetId).name}`),
      ),
  }
  return input
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function present(operation, value) {
  return { operation, status: "PRESENT", httpStatus: 200, code: null, value }
}
function absent(operation) {
  return { operation, status: "AMBIGUOUS", httpStatus: 404, code: "NOT_FOUND_OR_HIDDEN" }
}
function binary(operation, bytes) {
  return {
    operation,
    status: "PRESENT",
    httpStatus: 200,
    code: null,
    contentBase64: bytes.toString("base64"),
  }
}

test("fresh GitHub job timestamps accept seconds precision and expiry uses the explicit observation clock", async () => {
  const input = await originalFixture()
  for (const jobs of input.jobs)
    for (const job of jobs) {
      job.startedAt = "2026-10-26T12:00:00Z"
      job.completedAt = "2026-10-26T12:01:00Z"
    }
  input.github.getActionsArtifact = async () => absent("actions-artifact")
  input.github.listActionsRunArtifacts = async () => present("actions-run-artifacts", [])

  await assert.rejects(
    historical.authenticateHistoricalOriginalEvidence({
      ...input,
      now: Date.parse("2026-10-27T10:00:00Z"),
    }),
  )
  assert.equal(
    (
      await historical.authenticateHistoricalOriginalEvidence({
        ...input,
        now: Date.parse("2026-10-27T13:00:00Z"),
      })
    ).receiptSha256,
    input.record.incident.originalReceiptSha256,
  )
})

test("exact historical completion returns only AUDIT_COMPLETE terminal no-op and no ordinary receipt", async () => {
  const input = await completionFixture()
  const proof = historical.createHistoricalCompletion(input)
  const observation = { ...input.observation, historicalCompletion: proof }

  const plan = planRelease({ candidate: input.candidate, observation, mode: "controller" })

  assert.equal(proof.kind, "historical-completion")
  assert.equal(proof.original.signatureAssertionSource, "authenticated-original-npm-receipt")
  assert.equal(
    proof.packages.find((row) => row.entry.name === "create-b4-app").verification.keyedPublish
      .status,
    "unavailable",
  )
  assert.equal(
    observation.registry.packages.find((row) => row.name === "create-b4-app").signature.status,
    "missing",
  )
  assert.equal(plan.state, "AUDIT_COMPLETE")
  assert.equal(plan.disposition, "noop")
  assert.equal(plan.nextTransition, null)
  assert.deepEqual(plan.proposedMutations, [])
  assert.deepEqual(plan.conflicts, [])
})

for (const [name, mutate] of [
  [
    "inventory",
    (o) => {
      o.inventory.status = "invalid"
    },
  ],
  [
    "CI",
    (o) => {
      o.ci.status = "failed"
    },
  ],
  [
    "tag",
    (o) => {
      o.tag.status = "absent"
    },
  ],
  [
    "artifact",
    (o) => {
      o.artifacts.attestations[0].status = "invalid"
    },
  ],
  [
    "escrow",
    (o) => {
      o.escrow.assets.pop()
    },
  ],
  [
    "release asset",
    (o) => {
      o.release.assets[0].sha256 = "0".repeat(64)
    },
  ],
  [
    "canonical marker",
    (o) => {
      o.release.bodySha256 = "0".repeat(64)
    },
  ],
  [
    "draft",
    (o) => {
      o.release.status = "draft"
      o.release.immutable = false
    },
  ],
  [
    "not immutable",
    (o) => {
      o.release.immutable = false
    },
  ],
  [
    "smoke",
    (o) => {
      o.smokes[0].status = "failed"
    },
  ],
  [
    "audit",
    (o) => {
      o.audit.status = "failed"
      o.audit.conclusion = "failure"
    },
  ],
  [
    "abandonment",
    (o) => {
      o.abandonment.requested = true
    },
  ],
  [
    "adjudication",
    (o) => {
      o.smokeAdjudication = {}
    },
  ],
  [
    "arbitration",
    (o) => {
      o.otherCandidates.push({
        version: "0.15.4",
        commitSha: "1".repeat(40),
        state: "CANDIDATE_TAGGED",
      })
    },
  ],
  [
    "npm bytes",
    (o) => {
      o.registry.packages[0].tarballSha256 = "0".repeat(64)
    },
  ],
  [
    "npm signature",
    (o) => {
      o.registry.packages[0].signature.status = "missing"
    },
  ],
  [
    "latest missing",
    (o) => {
      o.registry.packages[0].latest = { status: "e404", version: null }
    },
  ],
  [
    "latest ambiguous",
    (o) => {
      o.registry.packages[0].latest = { status: "ambiguous", version: null }
    },
  ],
]) {
  test(`historical completion rejects changed ${name} without progression authority`, async () => {
    const input = await completionFixture()
    const proof = historical.createHistoricalCompletion(input)
    const observation = { ...input.observation, historicalCompletion: proof }
    mutate(observation)

    const plan = planRelease({ candidate: input.candidate, observation, mode: "controller" })

    assert.equal(plan.disposition, "blocked")
    assert.equal(plan.nextTransition, null)
    assert.deepEqual(plan.proposedMutations, [])
  })
}

test("historical proof rejects foreign incidents, ordinary npm receipts, and forged nested assertion fields", async () => {
  const input = await completionFixture(),
    proof = historical.createHistoricalCompletion(input)
  for (const mutate of [
    (proof) => {
      proof.incident.version = "0.15.7"
    },
    (proof) => {
      proof.recordSha256 = "0".repeat(64)
    },
    (proof) => {
      proof.original.publisher.runId++
    },
    (proof) => {
      proof.packages[0].verification.signature.status = "missing"
    },
    (proof) => {
      proof.packages[20].verification.keyedPublish.status = "valid"
    },
    (proof) => {
      proof.extra = true
    },
  ]) {
    const forged = structuredClone(proof)
    mutate(forged)
    const plan = planRelease({
      candidate: input.candidate,
      observation: { ...input.observation, historicalCompletion: forged },
      mode: "controller",
    })
    assert.equal(plan.disposition, "blocked")
    assert.equal(plan.nextTransition, null)
  }
  const ordinary = structuredClone(input.observation)
  ordinary.registry.packages.find((row) => row.name === "create-b4-app").signature.status = "valid"
  assert.equal(
    planRelease({
      candidate: input.candidate,
      observation: { ...ordinary, historicalCompletion: proof },
      mode: "controller",
    }).disposition,
    "blocked",
  )
})

async function completionFixture() {
  const originalInput = await originalFixture()
  const record = originalInput.record
  const source = observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })
  const mapping = new Map([
    ["0.8.22", TEST_CANDIDATE.version],
    ["0123456789abcdef0123456789abcdef01234567", TEST_CANDIDATE.commitSha],
    ["a".repeat(64), record.incident.manifestSha256],
    ["d".repeat(64), record.original.audit.receipts[0].sha256],
    ["e".repeat(64), record.incident.originalReceiptSha256],
  ])
  source.inventory.packages.forEach((pkg, index) => {
    const entry = TEST_MANIFEST.packages[index]
    for (const [key, value] of [
      ["name", entry.name],
      ["filename", entry.filename],
      ["attestationFilename", `${entry.filename}.intoto.jsonl`],
      ["tarballSha256", entry.sha256],
    ])
      mapping.set(pkg[key], value)
  })
  const replace = (value) => {
    if (typeof value === "string")
      return (
        mapping.get(value) ??
        value
          .replaceAll("0.8.22", "0.15.5")
          .replaceAll("500", "40376822663")
          .replaceAll("400", "40370125207")
      )
    if (value === 500) return record.incident.auditRunId
    if (value === 400 || value === 300) return record.incident.publisherRunId
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, replace(value)]))
    return value
  }
  const observation = replace(source)
  observation.inventory.packages.forEach((pkg, index) => {
    pkg.integrity = TEST_MANIFEST.packages[index].npmIntegrity
  })
  observation.artifacts.files.forEach((pkg, index) => {
    pkg.integrity = TEST_MANIFEST.packages[index].npmIntegrity
  })
  observation.registry.packages.forEach((pkg, index) => {
    pkg.integrity = TEST_MANIFEST.packages[index].npmIntegrity
  })
  observation.registry.packages.find((pkg) => pkg.name === "create-b4-app").signature.status =
    "missing"
  observation.ci.workflowRunId = TEST_MANIFEST.ci.runId
  observation.ci.runAttempt = TEST_MANIFEST.ci.runAttempt
  const marker = observation.release.marker
  const subjects = marker.attestationSet.subjects
  const base = [
    observation.artifacts.releaseRecordAsset,
    observation.artifacts.manifestAsset,
    ...subjects.slice(1).map((s) => ({ name: s.subjectName, sha256: s.subjectSha256 })),
    ...subjects.map((s) => ({ name: s.bundleName, sha256: s.bundleSha256 })),
  ]
  marker.baseAssetSetSha256 = hash(Buffer.from(`${JSON.stringify(base)}\n`))
  observation.release.bodySha256 = hash(
    Buffer.from(canonicalReleaseBody({ marker, manifest: null })),
  )
  originalInput.github.getRelease = async () =>
    present("release", {
      id: record.incident.releaseId,
      tag_name: record.incident.tag,
      immutable: true,
      draft: false,
      body: canonicalReleaseBody({ marker, manifest: null }),
    })
  const original = await historical.authenticateHistoricalOriginalEvidence({
    ...originalInput,
    selectedRelease: { id: record.incident.releaseId, bodySha256: observation.release.bodySha256 },
  })
  const packages = TEST_MANIFEST.packages.map((entry) => ({
    entry,
    verification:
      entry.name === "create-b4-app"
        ? parseHistoricalNpmAuditResult(
            { stdout: JSON.stringify(TEST_OFFICIAL_AUDIT), stderr: "", exitCode: 0 },
            {
              entry,
              candidate: TEST_CANDIDATE,
              record,
              manifest: TEST_MANIFEST,
              npmVersion: "11.17.0",
            },
          )
        : {
            status: "verified",
            signature: { status: "valid", verifier: NPM_AUDIT_VERIFIER },
            provenance: {
              predicateType: "https://slsa.dev/provenance/v1",
              workflow: TEST_CANDIDATE.publisherWorkflow,
              commitSha: TEST_CANDIDATE.commitSha,
              repository: "https://github.com/cacheplane/b4run",
              ref: "refs/tags/v0.15.5",
            },
          },
  }))
  return {
    candidate: { ...TEST_CANDIDATE, ciWorkflow: "CI", ciCheck: "validate" },
    manifest: TEST_MANIFEST,
    record,
    original,
    packages,
    observation,
    progressRank: RELEASE_PROGRESS_RANK,
  }
}

test("historical composition permits a valid newer latest without rollback and rechecks gates independent of bindings", async () => {
  const input = await completionFixture()
  input.observation.registry.packages.forEach((pkg) => {
    pkg.latest.version = "0.15.7"
  })
  const proof = historical.createHistoricalCompletion(input)
  const observation = { ...input.observation, historicalCompletion: structuredClone(proof) }
  assert.equal(
    planRelease({ candidate: input.candidate, observation, mode: "controller" }).disposition,
    "noop",
  )
  observation.ci.status = "failed"
  observation.historicalCompletion.obligations.ci = hash(
    Buffer.from(JSON.stringify(observation.ci)),
  )

  const plan = planRelease({ candidate: input.candidate, observation, mode: "controller" })

  assert.equal(plan.disposition, "blocked")
  assert.ok(plan.conflicts.includes("candidate-ci-failed"))
})

test("historical package assertion is exact, incident-bound and independent of original signature assertion", async () => {
  const input = await completionFixture()
  const row = input.packages.find((row) => row.entry.name === "create-b4-app")

  assert.equal(
    historical.isHistoricalNpmAuditEvidence(row.verification, {
      candidate: input.candidate,
      record: input.record,
      manifest: input.manifest,
      entry: row.entry,
    }),
    true,
  )
  assert.equal(
    historical.isHistoricalNpmAuditEvidence(
      { ...row.verification, extra: true },
      {
        candidate: input.candidate,
        record: input.record,
        manifest: input.manifest,
        entry: row.entry,
      },
    ),
    false,
  )
  assert.equal(
    historical.isHistoricalNpmAuditEvidence(row.verification, {
      candidate: { ...input.candidate, version: "0.15.7" },
      record: input.record,
      manifest: input.manifest,
      entry: row.entry,
    }),
    false,
  )
})

test("original authentication checks exact historical tag object as well as its peeled commit", async () => {
  const input = await originalFixture()
  input.tagObjectSha = "1".repeat(40)

  await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
})

for (const field of ["workflowRunId", "runAttempt"])
  test(`historical proof binds exact sealed CI ${field} independently of stored observation bindings`, async () => {
    const input = await completionFixture(),
      proof = historical.createHistoricalCompletion(input)
    const observation = { ...input.observation, historicalCompletion: structuredClone(proof) }
    observation.ci[field]++
    observation.historicalCompletion.obligations.ci = hash(
      Buffer.from(JSON.stringify(observation.ci)),
    )

    assert.equal(
      planRelease({ candidate: input.candidate, observation, mode: "controller" }).disposition,
      "blocked",
    )
  })

test("absence of a historical proof preserves the ordinary strict npm signature hold", async () => {
  const input = await completionFixture()

  const plan = planRelease({
    candidate: input.candidate,
    observation: input.observation,
    mode: "controller",
  })

  assert.equal(plan.disposition, "blocked")
  assert.ok(plan.conflicts.includes("npm-signature-missing"))
  assert.equal(plan.nextTransition, null)
})

test("historical composition canonicalizes independently observed package order without dropping duplicates", async () => {
  const input = await completionFixture()
  input.packages.reverse()

  const proof = historical.createHistoricalCompletion(input)

  assert.deepEqual(
    proof.packages.map((row) => row.entry.name),
    TEST_MANIFEST.packageOrder,
  )
  input.packages[0] = input.packages[1]
  assert.throws(() => historical.createHistoricalCompletion(input))
})

test("historical observation rejects contradictory adoption ownership even under a foreign file name", async () => {
  const input = await originalFixture()
  const adoption = JSON.parse(
    await readFile(new URL("../recovery-adoptions/v0.8.24.json", import.meta.url), "utf8"),
  )
  adoption.candidate.version = "0.15.5"
  adoption.candidate.candidateSha = TEST_CANDIDATE.commitSha
  adoption.candidate.tag = "v0.15.5"
  input.files.set(
    "scripts/release/recovery-adoptions/foreign-name.json",
    Buffer.from(JSON.stringify(adoption)),
  )

  await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
})

test("observation schema accepts only the exact optional historical proof keys", async () => {
  const { findObservationSchemaConflicts } = await import("../observation-schema.mjs")
  const input = await completionFixture(),
    proof = historical.createHistoricalCompletion(input)

  assert.deepEqual(
    findObservationSchemaConflicts({ ...input.observation, historicalCompletion: proof }),
    [],
  )
  assert.ok(
    findObservationSchemaConflicts({
      ...input.observation,
      historicalCompletion: { ...proof, extra: true },
    }).includes("observation-schema-invalid"),
  )
})

test("malformed historical observation structure returns a blocked plan instead of throwing", async () => {
  const input = await completionFixture()
  const proof = historical.createHistoricalCompletion(input)

  const plan = planRelease({
    candidate: input.candidate,
    observation: { ...input.observation, historicalCompletion: proof, otherCandidates: {} },
    mode: "controller",
  })

  assert.equal(plan.disposition, "blocked")
  assert.equal(plan.nextTransition, null)
})

test("expired artifact fallback never swallows transport, authentication, or malformed response failures", async () => {
  for (const response of [
    { operation: "actions-artifact", status: "AMBIGUOUS", httpStatus: 404, code: "TIMEOUT" },
    { operation: "actions-artifact", status: "AMBIGUOUS", httpStatus: 403, code: "FORBIDDEN" },
    { operation: "foreign", status: "AMBIGUOUS", httpStatus: 404, code: "NOT_FOUND_OR_HIDDEN" },
    {
      operation: "actions-artifact",
      status: "AMBIGUOUS",
      httpStatus: 404,
      code: "NOT_FOUND_OR_HIDDEN",
      extra: true,
    },
  ]) {
    const input = await originalFixture()
    input.github.getActionsArtifact = async () => response
    input.github.listActionsRunArtifacts = async () => present("actions-run-artifacts", [])

    await assert.rejects(historical.authenticateHistoricalOriginalEvidence(input))
  }
})

test("proven expired metadata may survive an empty run inventory while retained archive stays authenticated", async () => {
  const input = await originalFixture()
  input.artifact.expired = true
  input.github.listActionsRunArtifacts = async () => present("actions-run-artifacts", [])
  input.github.downloadActionsArtifact = async () => ({
    operation: "actions-artifact-download",
    status: "AMBIGUOUS",
    httpStatus: 410,
    code: "HTTP_410",
  })

  assert.equal(
    (await historical.authenticateHistoricalOriginalEvidence(input)).receiptSha256,
    input.record.incident.originalReceiptSha256,
  )
})

test("historical composition requires a positively present exact tag even with freshly generated bindings", async () => {
  const input = await completionFixture(),
    proof = historical.createHistoricalCompletion(input)
  input.observation.tag = { status: "absent", commitSha: null }

  assert.throws(() => historical.createHistoricalCompletion(input))
  const observation = { ...input.observation, historicalCompletion: structuredClone(proof) }
  observation.historicalCompletion.obligations.tag = hash(
    Buffer.from(JSON.stringify(observation.tag)),
  )
  assert.equal(
    planRelease({ candidate: input.candidate, observation, mode: "controller" }).disposition,
    "blocked",
  )
})

test("original authentication binds the selected immutable Release ID and fresh canonical body", async () => {
  for (const selectedRelease of [
    { id: 1, bodySha256: hash(Buffer.from("release body")) },
    { id: 424591222, bodySha256: hash(Buffer.from("different body")) },
  ]) {
    const input = await originalFixture()
    input.github.getRelease = async () =>
      present("release", {
        id: 424591222,
        tag_name: "v0.15.5",
        immutable: true,
        draft: false,
        body: "release body",
      })

    await assert.rejects(
      historical.authenticateHistoricalOriginalEvidence({ ...input, selectedRelease }),
    )
  }
})
