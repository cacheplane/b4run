import { snapshotJson } from "./adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import {
  canonicalTerminalRecordBytes,
  parseOperatorRecoveryRecord,
  TAGGED_0153_RECOVERY,
} from "./terminal-record-store.mjs"

const P = TAGGED_0153_RECOVERY
const WORKFLOW = ".github/workflows/release.yml"
const NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
const SHA = /^[a-f0-9]{40}$/u
const MAX_RUNS = 128

/**
 * Capture canonical git-only terminal evidence for the pinned 0.15.3 incident.
 * All injected service capabilities are readers. Nothing changes release state;
 * authority takes effect only after the output is reviewed and merged into main.
 */
export async function captureTagged0153Record({
  github,
  npm,
  reviewedCommit,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  requireThat(
    typeof reviewedCommit === "string" && SHA.test(reviewedCommit),
    "Invalid reviewed commit",
  )
  const startedAt = now()
  requireThat(Number.isSafeInteger(startedAt) && startedAt >= 0, "Invalid capture clock")
  const before = await githubSnapshot(github, reviewedCommit)
  const first = await npmSweep(npm, now)
  await wait(60000)
  const second = await npmSweep(npm, now)
  const after = await githubSnapshot(github, reviewedCommit)
  requireThat(
    JSON.stringify(before) === JSON.stringify(after),
    "GitHub evidence changed during capture",
  )
  const capturedAt = now()
  requireThat(
    Number.isSafeInteger(capturedAt) &&
      capturedAt >= startedAt &&
      capturedAt - startedAt <= 15 * 60000,
    "The complete capture window exceeds fifteen minutes",
  )
  const record = {
    schemaVersion: 2,
    kind: "abandoned-prepublication",
    version: P.version,
    commitSha: P.commitSha,
    tag: { name: P.tag, objectSha: P.tagObjectSha, commitSha: P.commitSha },
    reason: "Immutable 0.15.3 preparation fails its consumer install; superseded by 0.15.4.",
    predecessor: {
      state: "CANDIDATE_TAGGED",
      releaseId: null,
      releaseStatus: "absent",
      bodySha256: null,
      marker: null,
      artifact: null,
    },
    evidence: {
      escrowAssets: [],
      npm: { observations: [first, second] },
      releaseRuns: before.releaseRuns,
      duplicateRecovery: null,
    },
    authority: {
      mode: "operator-recovery",
      operator: before.operator.login,
      capturedAt: new Date(capturedAt).toISOString(),
      reviewedCommit,
    },
  }
  const bytes = canonicalTerminalRecordBytes(record)
  parseOperatorRecoveryRecord(bytes)
  return bytes
}

async function npmSweep(npm, now) {
  const packages = await Promise.all(
    NAMES.map(async (name) => {
      const result = await npm.observePackageVersion({ name, version: P.version })
      requireThat(
        result?.status === "ABSENT" &&
          result.operation === "package-version" &&
          result.httpStatus === 404 &&
          result.code === "E404",
        `Exact npm absence is unproven for ${name}`,
      )
      return { name, version: P.version, status: "ABSENT", httpStatus: 404, code: "E404" }
    }),
  )
  return { observedAt: new Date(now()).toISOString(), packages }
}

async function githubSnapshot(github, reviewedCommit) {
  const [repository, operator, main, ref, tag, releases, workflows] = await Promise.all([
    github.getRepository().then((result) => present(result, "repository")),
    github.getAuthenticatedUser().then((result) => present(result, "operator")),
    github.getRef({ ref: "heads/main" }).then((result) => present(result, "main ref")),
    github.getRef({ ref: `tags/${P.tag}` }).then((result) => present(result, "tag ref")),
    github.getGitTag({ tagSha: P.tagObjectSha }).then((result) => present(result, "annotated tag")),
    github.listReleases().then((result) => present(result, "Release inventory")),
    github
      .listRepositoryWorkflowsComplete()
      .then((result) => present(result, "workflow inventory")),
  ])
  requireThat(
    repository.id === P.repositoryId &&
      repository.full_name === P.repository &&
      repository.default_branch === "main",
    "Repository identity changed",
  )
  requireThat(
    Number.isSafeInteger(operator.id) &&
      operator.id > 0 &&
      typeof operator.login === "string" &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(operator.login),
    "Invalid authenticated operator",
  )
  requireThat(
    main.ref === "refs/heads/main" && main.object?.type === "commit" && SHA.test(main.object.sha),
    "Invalid live main ref",
  )
  const comparison = present(
    await github.compareCommits({ baseSha: reviewedCommit, headSha: main.object.sha }),
    "reviewed commit ancestry",
  )
  requireThat(
    ["ahead", "identical"].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === reviewedCommit,
    "Reviewed commit is not reachable from live main",
  )
  requireThat(
    ref.ref === `refs/tags/${P.tag}` &&
      ref.object?.type === "tag" &&
      ref.object.sha === P.tagObjectSha,
    "Pinned tag ref changed",
  )
  requireThat(
    tag.sha === P.tagObjectSha &&
      tag.tag === P.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === P.commitSha,
    "Pinned annotated tag changed",
  )
  requireThat(
    Array.isArray(releases) &&
      releases.every(
        (release) => Number.isSafeInteger(release.id) && typeof release.tag_name === "string",
      ) &&
      !releases.some((release) => release.tag_name === P.tag),
    "Candidate Release must be absent",
  )
  requireThat(Array.isArray(workflows), "Incomplete workflow inventory")
  const owners = workflows.filter((workflow) => workflow.path === WORKFLOW)
  requireThat(
    owners.length === 1 &&
      Number.isSafeInteger(owners[0].id) &&
      owners[0].id > 0 &&
      owners[0].state === "active",
    "Release workflow identity is not exact",
  )
  const workflowId = owners[0].id
  const runs = present(
    await github.listWorkflowRunsAllShasComplete({ workflowId }),
    "complete workflow runs",
  )
  requireThat(Array.isArray(runs), "Incomplete release-run inventory")
  const inventoryIds = new Set()
  for (const run of runs) {
    requireThat(
      Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        !inventoryIds.has(run.id) &&
        SHA.test(run.head_sha) &&
        run.workflow_id === workflowId &&
        run.path === WORKFLOW &&
        run.repository?.id === P.repositoryId &&
        run.repository.full_name === P.repository &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        run.status === "completed" &&
        typeof run.conclusion === "string" &&
        run.conclusion.length > 0,
      "Complete release inventory is malformed or has an active coordinator",
    )
    inventoryIds.add(run.id)
  }
  const candidates = runs.filter((run) => run.head_sha === P.commitSha)
  requireThat(
    candidates.length > 0 && candidates.length <= MAX_RUNS,
    "Candidate run coverage is missing or unbounded",
  )
  const runIds = new Set()
  const releaseRuns = []
  const jobEvidence = []
  for (const run of [...candidates].sort((left, right) => left.id - right.id)) {
    requireThat(
      Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        !runIds.has(run.id) &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        run.run_attempt <= MAX_RUNS &&
        run.workflow_id === workflowId &&
        run.path === WORKFLOW &&
        run.repository?.id === P.repositoryId &&
        run.repository.full_name === P.repository &&
        run.status === "completed" &&
        typeof run.conclusion === "string",
      "Candidate run source or terminal state is invalid",
    )
    runIds.add(run.id)
    const jobs = present(
      await github.listActionsRunJobsComplete({ runId: run.id }),
      "complete candidate jobs",
    )
    requireThat(Array.isArray(jobs) && jobs.length > 0, "Candidate job coverage is missing")
    const jobIds = new Set()
    for (const job of jobs) {
      requireThat(
        Number.isSafeInteger(job.id) &&
          job.id > 0 &&
          !jobIds.has(job.id) &&
          job.run_id === run.id &&
          job.head_sha === P.commitSha &&
          Number.isSafeInteger(job.runAttempt) &&
          job.runAttempt > 0 &&
          job.runAttempt <= run.run_attempt &&
          job.status === "completed",
        "Candidate job source or terminal state is invalid",
      )
      jobIds.add(job.id)
    }
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const publishers = jobs.filter(
        (job) => job.runAttempt === attempt && job.name === "publish-npm",
      )
      requireThat(
        publishers.length === 1 && publishers[0].conclusion === "skipped",
        "Publication started or publisher-attempt coverage is not exact",
      )
      releaseRuns.push({
        workflowRunId: run.id,
        runAttempt: attempt,
        status: "completed",
        publishJobStarted: false,
      })
    }
    requireThat(releaseRuns.length <= MAX_RUNS, "Candidate attempts are unbounded")
    jobEvidence.push({
      id: run.id,
      conclusion: run.conclusion,
      jobs: [...jobs].sort((left, right) => left.id - right.id),
    })
  }
  return {
    repository: {
      id: repository.id,
      full_name: repository.full_name,
      default_branch: repository.default_branch,
    },
    operator: { id: operator.id, login: operator.login },
    main: main.object.sha,
    tag: { name: tag.tag, objectSha: tag.sha, commitSha: tag.object.sha },
    workflowId,
    releaseRuns,
    jobEvidence,
  }
}

function present(result, label) {
  requireThat(
    result?.status === "PRESENT" &&
      result.httpStatus === 200 &&
      result.code === null &&
      result.value !== undefined,
    `Cannot prove ${label}`,
  )
  return snapshotJson(result.value)
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}
