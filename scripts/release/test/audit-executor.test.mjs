import assert from "node:assert/strict"
import test from "node:test"
import { auditExecutorIdentity, authorizeAuditExecutor } from "../audit-executor.mjs"
import { auditExecutorFixture } from "./support/audit-executor-fixture.mjs"

test("legacy executor remains exact candidate/tag without additional authority reads", async () => {
  const candidate = { version: "0.8.26", commitSha: "4".repeat(40) }
  const executor = await authorizeAuditExecutor({
    candidate,
    run: { head_sha: candidate.commitSha, head_branch: "v0.8.26" },
  })
  assert.deepEqual(auditExecutorIdentity({ candidate, executor }), {
    headSha: candidate.commitSha,
    headBranch: "v0.8.26",
  })
  assert.deepEqual(auditExecutorIdentity({ candidate }), {
    headSha: candidate.commitSha,
    headBranch: "v0.8.26",
  })
  assert.throws(() =>
    auditExecutorIdentity({
      candidate,
      executor: { headSha: "5".repeat(40), headBranch: "main" },
    }),
  )
})

test("main auditor requires actual merged executor source and exact successful CI", async () => {
  const f = auditExecutorFixture()
  const executor = await authorizeAuditExecutor(f)
  assert.deepEqual(auditExecutorIdentity({ candidate: f.candidate, executor }), {
    headSha: f.run.head_sha,
    headBranch: "main",
  })
  assert.throws(() =>
    auditExecutorIdentity({
      candidate: { ...f.candidate, commitSha: "9".repeat(40) },
      executor,
    }),
  )
})

for (const [name, mutate] of Object.entries({
  "wrong branch": (f) => {
    f.run.head_branch = "feature"
  },
  "wrong workflow": (f) => {
    f.run.path = ".github/workflows/other.yml"
  },
  "wrong repository": (f) => {
    f.run.repository.id = 123
  },
  "unmerged source": (f) => {
    f.state.ancestor = false
  },
  "changed verifier": (f) => {
    f.files.set("scripts/release/independent-audit.mjs", "changed verifier")
  },
  "changed pins": (f) => {
    f.files.set("scripts/release/test/fixtures/release-script-hashes.json", "{}")
  },
  "failed CI": (f) => {
    f.state.ci.conclusion = "failure"
  },
  "wrong CI SHA": (f) => {
    f.state.ci.head_sha = "9".repeat(40)
  },
  "missing validate": (f) => {
    f.state.jobs = []
  },
  "foreign check": (f) => {
    f.state.checks[0].app.slug = "third-party"
  },
  "wrong attempt": (f) => {
    f.state.jobs[0].runAttempt = 2
  },
}))
  test(`rejects ${name}`, async () => {
    const f = auditExecutorFixture()
    mutate(f)
    await assert.rejects(authorizeAuditExecutor(f))
  })

test("missing correlated CI identifiers cannot satisfy equality checks", async () => {
  const f = auditExecutorFixture()
  delete f.state.ci.workflow_id
  delete f.state.ci.check_suite_id
  delete f.state.jobs[0].id
  delete f.state.checks[0].id
  delete f.state.checks[0].check_suite.id
  f.github.getWorkflow = async () => ({
    status: "PRESENT",
    value: { path: ".github/workflows/ci.yml" },
  })
  await assert.rejects(authorizeAuditExecutor(f))
})

test("frozen Dawn v0.8.26 authorization binds the reviewed workflow and complete source pins", async () => {
  const { readHistoricalReleaseFile } = await import("./support/frozen-history.mjs")
  const { createHash } = await import("node:crypto")
  const record = JSON.parse(
    readHistoricalReleaseFile("scripts/release/audit-executor-authorizations/v0.8.26.json"),
  )
  const hashFile = async (path) =>
    createHash("sha256").update(readHistoricalReleaseFile(path)).digest("hex")
  assert.deepEqual(record.candidate, {
    version: "0.8.26",
    commitSha: "470c871f258f5cd248904208bff6a89acbf3a56c",
    manifestSha256: "15c3afa7eea9e552d83c10e0e8bdd8ec6d9d4a6ac0b2a87e8e4ac09f5511306b",
  })
  assert.equal(record.workflowSha256, await hashFile(record.workflow))
  assert.equal(
    record.scriptPinsSha256,
    await hashFile("scripts/release/test/fixtures/release-script-hashes.json"),
  )
})

test("main audit delegates generic authority without per-release authorization", async () => {
  const f = auditExecutorFixture()
  f.files.delete(`scripts/release/audit-executor-authorizations/v${f.candidate.version}.json`)
  const executor = await authorizeAuditExecutor(f)
  assert.equal(auditExecutorIdentity({ candidate: f.candidate, executor }).headSha, f.run.head_sha)
})
