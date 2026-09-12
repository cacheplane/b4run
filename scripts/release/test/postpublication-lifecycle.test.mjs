import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  dispatchIndependentAudit,
  recordAuditAttempt,
  recordAuditDispatch,
  verifyAuditSuccess,
  waitForAudit,
} from "../audit.mjs"
import { runIndependentAudit } from "../independent-audit.mjs"
import {
  canonicalBaseAssetSet,
  canonicalReleaseBody,
  parseReleaseMarker,
  publishConsolidatedRelease,
  reconcileSmokeEvidence,
  releaseBodySha256,
} from "../metadata.mjs"
import { canonicalNpmEvidenceBytes } from "../npm-evidence.mjs"
import { observeProductionCandidate } from "../observe.mjs"
import { planRelease } from "../planner.mjs"
import { canonicalReleaseRecordBytes } from "../release-record.mjs"
import { canonicalSmokeResultBytes, REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { postpublicationExecutorFixture } from "./support/postpublication-executor-fixture.mjs"
import {
  CANDIDATE,
  COMMIT_SHA,
  completeNpmEvidence,
  escrowMarker,
  releaseFixture,
  sha256,
  VERSION,
  zip,
} from "./support/postpublication-lifecycle-fixture.mjs"

const present = (value, operation = "fixture") => ({
  status: "PRESENT",
  operation,
  httpStatus: 200,
  code: null,
  value,
})
const binary = (bytes) => ({
  status: "PRESENT",
  operation: "download",
  httpStatus: 200,
  code: null,
  contentBase64: bytes.toString("base64"),
})
const AUDIT_WORKFLOW = ".github/workflows/published-artifact-verify.yml"

test("frozen npm-complete candidate reaches immutable publication through distinct reviewed main smoke and audit executors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "postpublication-lifecycle-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = releaseFixture()
  const remote = lifecycleRemote(fixture)
  const frozen = [...remote.assets].map(([name, { bytes }]) => [name, Buffer.from(bytes)])
  assert.equal(frozen.length, 45, "45 canonical base assets")
  const npmDigest = parseReleaseMarker(remote.release.body).npmEvidenceSha256
  const candidateBytes = JSON.stringify(CANDIDATE)
  const recordBytes = JSON.stringify(fixture.record)
  const npmEvidence = completeNpmEvidence(fixture)
  const frozenNpmBytes = canonicalNpmEvidenceBytes(npmEvidence, {
    candidate: CANDIDATE,
    manifest: fixture.manifest,
    manifestSha256: fixture.record.manifestSha256,
  })
  const smokeResults = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
      workflowRunId: remote.smoke.run.id,
      runAttempt: 1,
      startedAt: "2026-09-01T01:00:00.000Z",
      finishedAt: "2026-09-01T01:01:00.000Z",
      checks: [
        {
          name: "published-package-install",
          conclusion: "success",
          detail: "verified",
        },
      ],
      conclusion: "success",
    }),
  )
  remote.setArtifacts(
    remote.smoke.run,
    smokeResults.map((bytes, i) => ({
      name: `smoke-result-${REQUIRED_RELEASE_SMOKE_LANES[i]}-${remote.smoke.run.id}-1`,
      filename: `${REQUIRED_RELEASE_SMOKE_LANES[i]}.json`,
      bytes,
    })),
  )
  const input = {
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    smokeResults,
    workflowRunId: remote.smoke.run.id,
    runAttempt: 1,
    github: remote.github,
    git: remote.git,
  }
  const beforeRejected = remote.snapshot()
  const artifact = remote.artifacts.get(remote.smoke.run.id)[0]
  artifact.workflow_run.head_sha = remote.audit.run.head_sha
  await assert.rejects(reconcileSmokeEvidence(input), /identity|executor|artifact/iu)
  assert.deepEqual(
    remote.snapshot(),
    beforeRejected,
    "wrong artifact executor cannot mutate the release",
  )
  artifact.workflow_run.head_sha = remote.smoke.run.head_sha
  assert.equal((await reconcileSmokeEvidence(input)).phase, "SMOKES_COMPLETE")
  const afterSmoke = remote.snapshot()
  assert.equal((await reconcileSmokeEvidence(input)).status, "unchanged")
  assert.deepEqual(remote.snapshot(), afterSmoke, "exact smoke replay has no mutation")

  // Main advances after smoke production and again after audit dispatch. Source-bound
  // reads retain both reviewed executors instead of consulting the current checkout.
  remote.mainSha = remote.audit.run.head_sha
  const dispatch = await dispatchIndependentAudit({
    candidate: CANDIDATE,
    manifestSha256: fixture.record.manifestSha256,
    github: remote.github.writer,
    ref: "main",
  })
  assert.deepEqual(remote.dispatches[0], {
    workflow: AUDIT_WORKFLOW,
    ref: "main",
    inputs: {
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
    },
  })
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch,
    github: remote.github,
  })
  assert.equal(parseReleaseMarker(remote.release.body).phase, "AUDIT_DISPATCHED")
  remote.mainSha = "9".repeat(40)
  for (const artifact of remote.artifacts.get(remote.smoke.run.id)) {
    artifact.expired = true
    remote.archives.delete(artifact.id)
  }
  const beforeIndependentAudit = remote.snapshot()
  const resultPath = path.join(directory, "audit-result.json")
  const result = await runIndependentAudit(
    [
      "--version",
      VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--manifest-sha256",
      fixture.record.manifestSha256,
      "--result",
      resultPath,
    ],
    {
      environment: {
        GITHUB_REPOSITORY: "cacheplane/b4run",
        GITHUB_REPOSITORY_ID: "1210070282",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF: `cacheplane/b4run/${AUDIT_WORKFLOW}@refs/heads/main`,
        GITHUB_SHA: remote.audit.run.head_sha,
        GITHUB_RUN_ID: String(remote.audit.run.id),
        GITHUB_RUN_ATTEMPT: "1",
      },
      cwd: directory,
      createRuntime: async () => ({
        ...remote.runtime,
        observeProductionCandidate: async (args) => {
          const observed = await observeProductionCandidate(args)
          assert.deepEqual(observed.diagnostics, [])
          remote.observations.push(observed.observation)
          return observed
        },
      }),
      now: () => new Date("2026-09-01T02:00:00.000Z"),
      clock: () => 0,
      delay: async () => {},
      pollAttempts: 1,
      pollDelayMs: 0,
      pollTimeoutMs: 100,
    },
  )
  assert.equal(result.conclusion, "success", JSON.stringify(result))
  assert.deepEqual(
    remote.snapshot(),
    beforeIndependentAudit,
    "independent verification is read-only",
  )
  assert.deepEqual(await readFile(resultPath), canonicalAuditResultBytes(result))
  assert.equal(remote.observations.length, 1, "real independent audit used the production observer")
  assert.equal(
    planRelease({
      candidate: CANDIDATE,
      observation: remote.observations[0],
      mode: "controller",
    }).state,
    "AUDIT_DISPATCHED",
  )
  assert.notEqual(remote.smoke.run.head_sha, remote.audit.run.head_sha)
  assert.notEqual(COMMIT_SHA, remote.audit.run.head_sha)

  remote.audit.run.status = "completed"
  remote.audit.run.conclusion = "success"
  remote.setArtifacts(remote.audit.run, [
    {
      name: `audit-result-${remote.audit.run.id}-1`,
      filename: "audit-result.json",
      bytes: await readFile(resultPath),
    },
  ])
  const auditArtifact = remote.artifacts.get(remote.audit.run.id)[0]
  auditArtifact.workflow_run.head_sha = remote.smoke.run.head_sha
  const beforeRejectedAudit = remote.snapshot()
  await assert.rejects(
    waitForAudit({
      candidate: CANDIDATE,
      manifestSha256: fixture.record.manifestSha256,
      git: remote.git,
      github: remote.github.reader,
      runId: dispatch.workflowRunId,
      attempts: 1,
      delayMs: 0,
      delay: async () => {},
    }),
    /artifact|identity/iu,
  )
  assert.deepEqual(remote.snapshot(), beforeRejectedAudit)
  auditArtifact.workflow_run.head_sha = remote.audit.run.head_sha
  const polled = await waitForAudit({
    candidate: CANDIDATE,
    manifestSha256: fixture.record.manifestSha256,
    git: remote.git,
    github: remote.github.reader,
    runId: dispatch.workflowRunId,
    attempts: 1,
    delayMs: 0,
    delay: async () => {},
  })
  assert.equal(polled.status, "terminal")
  assert.deepEqual(polled.result, result)
  await recordAuditAttempt({
    candidate: CANDIDATE,
    dispatch,
    result: polled.result,
    github: remote.github,
  })
  await verifyAuditSuccess({
    candidate: CANDIDATE,
    dispatch,
    result: polled.result,
    github: remote.github,
  })
  assert.equal(parseReleaseMarker(remote.release.body).phase, "AUDIT_VERIFIED")
  const laterObservation = await observeProductionCandidate({
    ...remote.runtime,
    candidate: CANDIDATE,
    inventory: await remote.runtime.inventory.read(),
    marker: remote.runtime.controllerMarker,
    github: remote.github.reader,
    terminalRecordRef: remote.mainSha,
  })
  assert.deepEqual(laterObservation.diagnostics, [])
  assert.equal(
    planRelease({
      candidate: CANDIDATE,
      observation: laterObservation.observation,
      mode: "controller",
    }).nextTransition,
    "publish-github-release",
  )
  await publishConsolidatedRelease({
    candidate: CANDIDATE,
    record: fixture.record,
    auditResult: result,
    github: remote.github,
  })
  assert.equal(remote.release.draft, false)
  assert.equal(remote.release.immutable, true)
  assert.equal(remote.publications, 1)
  assert.equal(JSON.stringify(CANDIDATE), candidateBytes)
  assert.equal(JSON.stringify(fixture.record), recordBytes)
  assert.deepEqual(
    canonicalNpmEvidenceBytes(npmEvidence, {
      candidate: CANDIDATE,
      manifest: fixture.manifest,
      manifestSha256: fixture.record.manifestSha256,
    }),
    frozenNpmBytes,
  )
  assert.equal(parseReleaseMarker(remote.release.body).npmEvidenceSha256, npmDigest)
  for (const [name, bytes] of frozen) assert.deepEqual(remote.assets.get(name).bytes, bytes, name)
  assert.deepEqual(remote.phases, ["SMOKES_COMPLETE", "AUDIT_DISPATCHED", "AUDIT_VERIFIED"])
})

function lifecycleRemote(fixture) {
  const smoke = postpublicationExecutorFixture({ candidate: CANDIDATE })
  const audit = postpublicationExecutorFixture({
    candidate: CANDIDATE,
    workflow: AUDIT_WORKFLOW,
  })
  audit.run.id = 502
  audit.run.head_sha = "7".repeat(40)
  audit.state.ci = { ...audit.state.ci, id: 602, head_sha: audit.run.head_sha }
  audit.state.checks[0].head_sha = audit.run.head_sha
  audit.run.status = "in_progress"
  audit.run.conclusion = null
  const baseBytes = new Map([
    ["release-record.json", canonicalReleaseRecordBytes(fixture.record)],
    ...fixture.artifact.files.map((f) => [f.name, f.bytes]),
    ...fixture.bundles.map((f) => [f.name, f.bytes]),
  ])
  const assets = new Map(
    canonicalBaseAssetSet({
      record: fixture.record,
      artifact: fixture.artifact,
      attestationSet: fixture.attestationSet,
      bundles: fixture.bundles,
    }).assets.map((asset, index) => [
      asset.name,
      { id: index + 1, bytes: Buffer.from(baseBytes.get(asset.name)) },
    ]),
  )
  const npmBytes = canonicalNpmEvidenceBytes(completeNpmEvidence(fixture), {
    candidate: CANDIDATE,
    manifest: fixture.manifest,
    manifestSha256: fixture.record.manifestSha256,
  })
  const marker = {
    ...escrowMarker(fixture),
    revision: 3,
    phase: "NPM_COMPLETE",
    npmEvidenceSha256: sha256(npmBytes),
  }
  const release = {
    id: 7,
    tag_name: `v${VERSION}`,
    target_commitish: "main",
    name: `B4 v${VERSION}`,
    draft: true,
    immutable: false,
    prerelease: false,
    body: canonicalReleaseBody({ marker, manifest: fixture.manifest }),
  }
  const remote = {
    smoke,
    audit,
    assets,
    release,
    mainSha: smoke.run.head_sha,
    artifacts: new Map(),
    archives: new Map(),
    dispatches: [],
    observations: [],
    phases: [],
    mutations: 0,
    publications: 0,
  }
  const candidateCi = {
    id: 10,
    name: "CI",
    workflow_id: 10,
    path: ".github/workflows/ci.yml",
    head_sha: COMMIT_SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    check_suite_id: 20,
  }
  const findRun = (id) =>
    [smoke.run, audit.run, smoke.state.ci, audit.state.ci, candidateCi].find(
      (run) => run.id === Number(id),
    )
  const reader = {
    compareCommits: async ({ baseSha, headSha }) =>
      present({
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        behind_by: 0,
        total_commits: baseSha === headSha ? 0 : 1,
        ahead_by: baseSha === headSha ? 0 : 1,
        status: baseSha === headSha ? "identical" : "ahead",
      }),
    getRef: async ({ ref }) =>
      present(
        ref.includes("main")
          ? {
              ref: "refs/heads/main",
              object: { type: "commit", sha: remote.mainSha },
            }
          : {
              ref: `refs/tags/v${VERSION}`,
              object: { type: "tag", sha: "a".repeat(40) },
            },
      ),
    getGitTag: async () =>
      present({
        tag: `v${VERSION}`,
        object: { type: "commit", sha: COMMIT_SHA },
      }),
    listTagRefs: async () =>
      present([
        {
          ref: `refs/tags/v${VERSION}`,
          object: { type: "tag", sha: "a".repeat(40) },
        },
      ]),
    listReleases: async () => present([{ ...release }]),
    getRelease: async () => present({ ...release }),
    listReleaseAssets: async () =>
      present(
        [...assets].map(([name, a]) => ({
          id: a.id,
          name,
          size: a.bytes.length,
          digest: `sha256:${sha256(a.bytes)}`,
        })),
      ),
    downloadReleaseAsset: async ({ assetId }) =>
      binary([...assets.values()].find((a) => a.id === assetId).bytes),
    listActionsArtifacts: async () => present([]),
    listActionsRunArtifacts: async ({ runId }) =>
      present(remote.artifacts.get(Number(runId)) ?? []),
    getActionsArtifact: async ({ artifactId }) =>
      present([...remote.artifacts.values()].flat().find((a) => a.id === artifactId)),
    downloadActionsArtifact: async ({ artifactId }) => binary(remote.archives.get(artifactId)),
    getActionsRun: async ({ runId }) => present(findRun(runId)),
    getActionsRunAttempt: async ({ runId, attempt }) => {
      assert.equal(attempt, 1)
      return present(findRun(runId))
    },
    getWorkflow: async ({ workflow }) =>
      present({
        id: workflow === "ci.yml" ? 10 : 20,
        path:
          workflow === "ci.yml"
            ? ".github/workflows/ci.yml"
            : workflow === "release.yml"
              ? ".github/workflows/release.yml"
              : AUDIT_WORKFLOW,
      }),
    listWorkflowRuns: async ({ workflow, commitSha }) =>
      present(
        workflow === "ci.yml"
          ? [candidateCi, smoke.state.ci, audit.state.ci].filter(
              (r) => !commitSha || r.head_sha === commitSha,
            )
          : [],
      ),
    getCommitCheckRuns: async ({ ref, commitSha = ref }) =>
      present(
        commitSha === COMMIT_SHA
          ? [
              {
                id: 10,
                name: "validate",
                head_sha: COMMIT_SHA,
                status: "completed",
                conclusion: "success",
                check_suite: { id: 20 },
              },
            ]
          : (commitSha === audit.run.head_sha ? audit : smoke).state.checks,
      ),
    listActionsRunJobs: async ({ runId }) =>
      present(
        Number(runId) === 10
          ? [
              {
                id: 10,
                runAttempt: 1,
                name: "validate",
                status: "completed",
                conclusion: "success",
                startedAt: "2026-09-01T00:00:00.000Z",
                completedAt: "2026-09-01T00:01:00.000Z",
              },
            ]
          : Number(runId) === audit.run.id
            ? [
                {
                  id: 800,
                  runAttempt: 1,
                  name: "verify",
                  startedAt: "2026-09-01T02:00:00.000Z",
                  completedAt: audit.run.status === "completed" ? "2026-09-01T02:01:00.000Z" : null,
                  status: audit.run.status,
                  conclusion: audit.run.conclusion,
                },
              ]
            : Number(runId) === 602
              ? audit.state.jobs
              : smoke.state.jobs,
      ),
  }
  const operations = {
    compareCommits: "compare-commits",
    getRef: "ref",
    getGitTag: "git-tag",
    listTagRefs: "tag-refs",
    listReleases: "releases",
    getRelease: "release",
    listReleaseAssets: "release-assets",
    downloadReleaseAsset: "release-asset-download",
    listActionsArtifacts: "actions-artifacts",
    listActionsRunArtifacts: "actions-run-artifacts",
    getActionsArtifact: "actions-artifact",
    downloadActionsArtifact: "actions-artifact-download",
    getActionsRun: "actions-run",
    getActionsRunAttempt: "actions-run-attempt",
    getWorkflow: "workflow",
    listWorkflowRuns: "workflow-runs",
    getCommitCheckRuns: "commit-check-runs",
    listActionsRunJobs: "actions-run-jobs",
  }
  for (const [method, operation] of Object.entries(operations)) {
    const read = reader[method]
    reader[method] = async (input) => ({ ...(await read(input)), operation })
  }
  const writer = {
    createDraftRelease: async () => {
      throw new Error("existing release must be reused")
    },
    updateDraftReleaseIfCurrent: async ({ expectedBodySha256, body }) => {
      assert.equal(releaseBodySha256(release.body), expectedBodySha256)
      assert.equal(release.draft, true)
      release.body = body
      remote.mutations++
      remote.phases.push(parseReleaseMarker(body).phase)
      return {
        releaseId: release.id,
        status: "updated",
        bodySha256: releaseBodySha256(body),
      }
    },
    uploadAssetIfAbsentAndEqual: async ({ name, bytes, sha256: digest }) => {
      if (assets.has(name)) {
        assert.deepEqual(assets.get(name).bytes, bytes)
        return {
          assetId: assets.get(name).id,
          status: "existing",
          sha256: digest,
        }
      }
      const id = assets.size + 1
      assets.set(name, { id, bytes: Buffer.from(bytes) })
      remote.mutations++
      return { assetId: id, status: "uploaded", sha256: digest }
    },
    publishReleaseIfCurrent: async ({ expectedBodySha256, assets: expected }) => {
      assert.equal(releaseBodySha256(release.body), expectedBodySha256)
      assert.equal(expected.length, assets.size)
      release.draft = false
      release.immutable = true
      remote.publications++
      return { releaseId: release.id, status: "published", immutable: true }
    },
    dispatchWorkflowAtRef: async (input) => {
      remote.dispatches.push(input)
      return {
        workflowRunId: audit.run.id,
        runUrl: `https://api.github.com/repos/cacheplane/b4run/actions/runs/${audit.run.id}`,
        htmlUrl: `https://github.com/cacheplane/b4run/actions/runs/${audit.run.id}`,
      }
    },
  }
  remote.github = { reader, writer }
  remote.git = {
    resolveTag: async () => COMMIT_SHA,
    listTree: async () => "",
    isAncestor: async () => true,
    showFile: async (input) =>
      (input.ref === audit.run.head_sha ? audit : smoke).git.showFile(input),
  }
  remote.snapshot = () => ({
    body: release.body,
    mutations: remote.mutations,
    assets: [...assets].map(([name, a]) => [name, sha256(a.bytes)]),
  })
  remote.setArtifacts = (run, files) =>
    remote.artifacts.set(
      run.id,
      files.map((file, index) => {
        const id = run.id * 10 + index
        const archive = zip([{ name: file.filename, bytes: file.bytes }])
        remote.archives.set(id, archive)
        return {
          id,
          name: file.name,
          digest: `sha256:${sha256(archive)}`,
          expired: false,
          workflow_run: {
            id: run.id,
            head_sha: run.head_sha,
            head_branch: run.head_branch,
          },
        }
      }),
    )
  const entries = new Map(fixture.manifest.packages.map((entry) => [entry.name, entry]))
  const tarballUrl = (entry) =>
    `https://registry.npmjs.org/${entry.name}/-/${entry.name.split("/").at(-1)}-${entry.version}.tgz`
  remote.runtime = {
    github: reader,
    git: remote.git,
    controllerMarker: {
      schemaVersion: 1,
      publishingOwner: "release-controller",
      epoch: "fixed-group-v1",
      npmTrustedPublisherEnvironment: null,
      abandonmentEnvironment: "release-abandonment",
    },
    inventory: {
      read: async () => ({
        status: "valid",
        packages: [...entries.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ name, version }) => ({ name, version })),
      }),
    },
    npm: {
      observePackageVersion: async ({ name, version }) => ({
        status: "PRESENT",
        operation: "package-version",
        httpStatus: 200,
        code: null,
        package: {
          name,
          version,
          tarballUrl: tarballUrl(entries.get(name)),
          shasum: "1".repeat(40),
          integrity: entries.get(name).npmIntegrity,
          distTags: { latest: version },
          latest: version,
        },
      }),
      downloadRegistryTarball: async ({ tarballUrl: url }) => {
        const entry = [...entries.values()].find((e) => tarballUrl(e) === url)
        return {
          status: "PRESENT",
          operation: "package-tarball",
          httpStatus: 200,
          code: null,
          tarball: {
            url,
            size: entry.size,
            sha1: "1".repeat(40),
            sha256: entry.sha256,
            sha512: entry.sha512,
            contentBase64: assets.get(entry.filename).bytes.toString("base64"),
          },
        }
      },
    },
    npmAuditFactory: {
      create: async () => ({
        verifyPackage: async ({ entry }) => {
          const evidence = completeNpmEvidence(fixture).packages.find((e) => e.name === entry.name)
          return {
            status: "verified",
            signature: evidence.signature,
            provenance: evidence.provenance,
          }
        },
        dispose: async () => {},
      }),
    },
    attestations: {
      verify: async ({ subjects }) => ({ status: "VERIFIED", subjects }),
    },
  }
  return remote
}
