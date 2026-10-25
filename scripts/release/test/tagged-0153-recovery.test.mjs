import assert from "node:assert/strict"
import test from "node:test"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { captureTagged0153Record } from "../tagged-0153-recovery.mjs"
import { parseOperatorRecoveryRecord } from "../terminal-record-store.mjs"
import { TAGGED_COMMIT, TAGGED_OBJECT } from "./support/tagged-0153-record-fixture.mjs"

const REVIEWED = "4".repeat(40)
const MAIN = "5".repeat(40)
const present = (value) => ({ status: "PRESENT", httpStatus: 200, code: null, value })

function captureFixture() {
  let time = Date.parse("2026-10-25T16:00:00.000Z")
  const calls = []
  const jobs = [1, 2].map((runAttempt) => ({
    id: 100 + runAttempt,
    runAttempt,
    name: "publish-npm",
    status: "completed",
    conclusion: "skipped",
    run_id: 40195141825,
    head_sha: TAGGED_COMMIT,
    startedAt: "2026-10-25T12:00:00Z",
    completedAt: "2026-10-25T12:00:00Z",
  }))
  const runs = [
    {
      id: 40195141825,
      run_attempt: 2,
      workflow_id: 123,
      path: ".github/workflows/release.yml",
      repository: { id: 1210070282, full_name: "cacheplane/b4run" },
      head_sha: TAGGED_COMMIT,
      status: "completed",
      conclusion: "failure",
    },
  ]
  const github = {
    getAuthenticatedUser: async () => present({ login: "blove", id: 7 }),
    getRepository: async () =>
      present({ id: 1210070282, full_name: "cacheplane/b4run", default_branch: "main" }),
    getRef: async ({ ref }) =>
      present({
        ref: `refs/${ref}`,
        object:
          ref === "heads/main"
            ? { type: "commit", sha: MAIN }
            : { type: "tag", sha: TAGGED_OBJECT },
      }),
    getGitTag: async () =>
      present({
        sha: TAGGED_OBJECT,
        tag: "v0.15.3",
        object: { type: "commit", sha: TAGGED_COMMIT },
      }),
    compareCommits: async () => present({ status: "ahead", merge_base_commit: { sha: REVIEWED } }),
    listReleases: async () => present([]),
    listRepositoryWorkflowsComplete: async () =>
      present([{ id: 123, path: ".github/workflows/release.yml", state: "active" }]),
    listWorkflowRunsAllShasComplete: async () => present(runs),
    listActionsRunJobsComplete: async () => present(jobs),
  }
  return {
    calls,
    jobs,
    runs,
    github,
    npm: {
      observePackageVersion: async ({ name, version }) => {
        calls.push({ name, version, time })
        return { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "E404" }
      },
    },
    reviewedCommit: REVIEWED,
    now: () => time,
    advance: (ms) => {
      time += ms
    },
    wait: async (ms) => {
      calls.push({ wait: ms })
      time += ms
    },
  }
}

test("captures only canonical read-only evidence, all attempts, and two independently requested npm sweeps", async () => {
  const f = captureFixture()

  const bytes = await captureTagged0153Record(f)
  const record = parseOperatorRecoveryRecord(bytes)

  assert.equal(record.schemaVersion, 2)
  assert.equal(record.authority.reviewedCommit, REVIEWED)
  assert.equal(record.evidence.releaseRuns.length, 2)
  assert.deepEqual(
    f.calls.filter((call) => call.wait),
    [{ wait: 60000 }],
  )
  for (const name of CANONICAL_RELEASE_PACKAGE_ORDER) {
    const calls = f.calls.filter((call) => call.name === name)
    assert.equal(calls.length, 2)
    assert.ok(calls[1].time - calls[0].time >= 60000)
    assert.equal(calls[0].version, "0.15.3")
  }
  assert.equal(record.evidence.escrowAssets.length, 0)
  assert.equal(record.evidence.duplicateRecovery, null)
})

test("refuses present or ambiguous registry results and a wait that does not establish a fresh observation", async () => {
  for (const result of [
    { status: "PRESENT", httpStatus: 200, code: null },
    { status: "AMBIGUOUS", httpStatus: 404, code: "E404" },
    { status: "ABSENT", httpStatus: 403, code: "E404" },
  ]) {
    const f = captureFixture()
    f.npm.observePackageVersion = async () => result
    await assert.rejects(captureTagged0153Record(f), /absence/iu)
  }
  const f = captureFixture()
  f.wait = async () => {}
  await assert.rejects(captureTagged0153Record(f), /sixty|out of order/iu)
})

test("refuses repository, tag, source, main ancestry, active jobs and incomplete publisher-attempt proofs", async () => {
  const changes = [
    (f) => {
      f.github.getRepository = async () =>
        present({ id: 1, full_name: "cacheplane/b4run", default_branch: "main" })
    },
    (f) => {
      f.github.getRef = async () =>
        present({ ref: "refs/tags/v0.15.3", object: { type: "commit", sha: TAGGED_COMMIT } })
    },
    (f) => {
      f.github.getGitTag = async () =>
        present({ sha: TAGGED_OBJECT, tag: "v0.15.3", object: { type: "commit", sha: MAIN } })
    },
    (f) => {
      f.github.compareCommits = async () =>
        present({ status: "diverged", merge_base_commit: { sha: MAIN } })
    },
    (f) => {
      f.github.listReleases = async () => present([{ id: 100, tag_name: "v0.15.3", draft: true }])
    },
    (f) => {
      f.runs[0].status = "in_progress"
    },
    (f) => {
      f.runs[0].repository.id = 1
    },
    (f) => {
      f.jobs[0].conclusion = "success"
    },
    (f) => {
      f.jobs.splice(0, 1)
    },
    (f) => {
      f.jobs[0].head_sha = MAIN
    },
    (f) => {
      f.jobs.push({ ...f.jobs[0], id: 500 })
    },
    (f) => {
      f.jobs[0].status = "in_progress"
    },
    (f) => {
      f.runs.push({ ...f.runs[0] })
    },
    (f) => {
      f.github.listWorkflowRunsAllShasComplete = async () => present([])
    },
    (f) => {
      f.github.listRepositoryWorkflowsComplete = async () =>
        present([
          { id: 123, path: ".github/workflows/release.yml", state: "active" },
          { id: 124, path: ".github/workflows/release.yml", state: "active" },
        ])
    },
  ]
  for (const change of changes) {
    const f = captureFixture()
    change(f)
    await assert.rejects(captureTagged0153Record(f))
    assert.equal(f.calls.length, 0)
  }
})

test("refuses changed operator, main, release inventory, tag or run evidence between surrounding snapshots", async () => {
  for (const method of [
    "getAuthenticatedUser",
    "getRef",
    "listReleases",
    "listWorkflowRunsAllShasComplete",
  ]) {
    const f = captureFixture()
    const original = f.github[method]
    let reads = 0
    f.github[method] = async (...args) => {
      const result = await original(...args)
      reads++
      const threshold = method === "getRef" ? 2 : 1
      if (reads <= threshold) return result
      if (method === "getAuthenticatedUser") return present({ login: "someone-else", id: 8 })
      if (method === "getRef")
        return present({ ...result.value, object: { ...result.value.object, sha: "9".repeat(40) } })
      if (method === "listReleases") return present([{ id: 100, tag_name: "v0.15.3", draft: true }])
      return present([{ ...f.runs[0], id: 40195141826 }])
    }
    await assert.rejects(captureTagged0153Record(f))
  }
})

test("retains independent snapshots even when a reader reuses mutable job objects", async () => {
  const f = captureFixture()
  const wait = f.wait
  f.wait = async (ms) => {
    await wait(ms)
    f.jobs[1].id += 10
  }

  await assert.rejects(captureTagged0153Record(f), /changed/iu)
})

test("requires exact absence again on the second sweep", async () => {
  const f = captureFixture()
  const original = f.npm.observePackageVersion
  let count = 0
  f.npm.observePackageVersion = async (input) =>
    ++count > CANONICAL_RELEASE_PACKAGE_ORDER.length
      ? { status: "PRESENT", operation: "package-version", httpStatus: 200, code: null }
      : original(input)

  await assert.rejects(captureTagged0153Record(f), /absence/iu)
})

test("bounds the complete capture window including the first GitHub inventory", async () => {
  const f = captureFixture()
  const read = f.github.getAuthenticatedUser
  let reads = 0
  f.github.getAuthenticatedUser = async () => {
    if (++reads === 1) f.advance(901000)
    return read()
  }

  await assert.rejects(captureTagged0153Record(f), /capture window/iu)
})

test("refuses active coordinator runs and malformed noncandidate records in the complete inventory", async () => {
  for (const extra of [
    {
      id: 500,
      run_attempt: 1,
      workflow_id: 123,
      path: ".github/workflows/release.yml",
      repository: { id: 1210070282, full_name: "cacheplane/b4run" },
      head_sha: MAIN,
      status: "in_progress",
      conclusion: null,
    },
    { id: 501, head_sha: "malformed" },
  ]) {
    const f = captureFixture()
    f.runs.push(extra)

    await assert.rejects(captureTagged0153Record(f))
    assert.equal(f.calls.length, 0)
  }
})
