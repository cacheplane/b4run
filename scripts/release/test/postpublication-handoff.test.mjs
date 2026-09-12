import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parse } from "yaml"

const workflowPath = new URL("../../../.github/workflows/release.yml", import.meta.url)
const postJobs = [
  "hydrate",
  "smoke-metadata",
  "smoke-published-harness",
  "smoke-runtime-targets",
  "smoke-scaffold",
  "smoke-storage",
  "reconcile-smokes",
  "dispatch-audit",
  "record-audit-dispatch",
  "correlate-audit",
  "publish-release",
]
const expr = (s) => `\${{ ${s} }}`
const checkout = (job) => job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))

test("main post-publication route is authorized in detect and pins every executor checkout", async () => {
  const { jobs } = parse(await readFile(workflowPath, "utf8"))
  assert.equal(jobs.detect.outputs.executor_sha, expr("steps.executor.outputs.executor_sha"))
  assert.equal(
    checkout(jobs.detect).with.ref,
    expr("github.ref == 'refs/heads/main' && github.sha || github.event.repository.default_branch"),
  )
  const authorize = jobs.detect.steps.find((s) => s.id === "executor")
  assert.match(authorize.if, /github.ref == 'refs\/heads\/main'/u)
  assert.match(authorize.if, /run-release-smokes/u)
  assert.doesNotMatch(
    authorize.if,
    /prepare-artifacts|publish-npm-packages|resume-npm-publish|reconcile-npm-evidence/u,
  )
  assert.match(authorize.run, /postpublication-executor\.mjs/u)
  assert.equal(jobs.detect.permissions.checks, "read")
  assert.equal(checkout(jobs.detect).with["fetch-depth"], 0)
  const relay = jobs.tag.steps.find((s) => s.id === "route")
  assert.equal(relay.env.EXECUTOR_SHA, expr("needs.detect.outputs.executor_sha"))
  assert.match(relay.run, /EXECUTOR_SHA/u)
  for (const id of postJobs) {
    const job = jobs[id]
    assert.match(job.if, /needs.detect.outputs.executor_sha == github.sha/u, id)
    assert.match(job.if, /github.ref == 'refs\/heads\/main'/u, id)
    assert.equal(
      checkout(job).with.ref,
      expr("needs.detect.outputs.executor_sha || needs.detect.outputs.candidate_sha"),
      id,
    )
  }
  for (const id of ["reconcile-smokes", "correlate-audit"]) {
    assert.equal(jobs[id].permissions.checks, "read", id)
    assert.equal(checkout(jobs[id]).with["fetch-depth"], 0, id)
  }
})

test("npm, artifact preparation and provenance remain restricted to the candidate tag", async () => {
  const { jobs } = parse(await readFile(workflowPath, "utf8"))
  for (const id of ["prepare", "attest", "escrow", "publish-npm", "reconcile-npm"]) {
    const job = jobs[id]
    assert.match(job.if, /github.sha == needs.detect.outputs.candidate_sha/u)
    assert.match(job.if, /github.ref == format\('refs\/tags\/v\{0\}', inputs.version\)/u)
    assert.doesNotMatch(job.if, /executor_sha/u, id)
    assert.equal(checkout(job).with.ref, expr("needs.detect.outputs.candidate_sha"), id)
  }
  assert.equal(jobs["publish-npm"].permissions["id-token"], "write")
})
