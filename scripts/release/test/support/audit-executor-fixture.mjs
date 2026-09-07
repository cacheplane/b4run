import { createHash } from "node:crypto"

export function auditExecutorFixture() {
  const candidate = { version: "0.8.26", commitSha: "4".repeat(40) }
  const manifestSha256 = "a".repeat(64)
  const workflow = ".github/workflows/published-artifact-verify.yml"
  const run = {
    id: 501,
    run_attempt: 1,
    head_sha: "5".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    path: workflow,
    repository: { id: 1360603908, full_name: "cacheplane/b4-run" },
  }
  const hash = (s) => createHash("sha256").update(s).digest("hex")
  const files = new Map([
    [workflow, "reviewed workflow"],
    ["scripts/release/audit-executor.mjs", "reviewed authority"],
    ["scripts/release/independent-audit.mjs", "reviewed verifier"],
    ["scripts/release/observe.mjs", "reviewed observer"],
    ["scripts/release/audit.mjs", "reviewed correlator"],
  ])
  const pins = JSON.stringify({
    schemaVersion: 1,
    scripts: Object.fromEntries(
      [...files]
        .filter(([p]) => p.startsWith("scripts/"))
        .map(([p, s]) => [p, { sha256: hash(s) }]),
    ),
  })
  files.set("scripts/release/test/fixtures/release-script-hashes.json", pins)
  const authorization = {
    schemaVersion: 1,
    repository: "cacheplane/b4-run",
    candidate: { ...candidate, manifestSha256 },
    workflow,
    workflowSha256: hash(files.get(workflow)),
    scriptPinsSha256: hash(pins),
  }
  files.set(
    `scripts/release/audit-executor-authorizations/v${candidate.version}.json`,
    JSON.stringify(authorization),
  )
  const ci = {
    id: 601,
    run_attempt: 1,
    head_sha: run.head_sha,
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    workflow_id: 10,
    check_suite_id: 11,
    repository: run.repository,
  }
  const state = {
    ancestor: true,
    ci,
    jobs: [
      { id: 701, name: "validate", runAttempt: 1, status: "completed", conclusion: "success" },
    ],
    checks: [
      {
        id: 701,
        name: "validate",
        head_sha: run.head_sha,
        check_suite: { id: 11 },
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
      },
    ],
  }
  const present = (value) => ({ status: "PRESENT", value })
  const git = {
    showFile: async ({ ref, path }) => {
      if (ref !== run.head_sha || !files.has(path)) throw new Error("unavailable source")
      return files.get(path)
    },
    isAncestor: async () => state.ancestor,
  }
  const github = {
    getRef: async () =>
      present({ ref: "refs/heads/main", object: { type: "commit", sha: "6".repeat(40) } }),
    listWorkflowRuns: async () => present([state.ci]),
    getActionsRunAttempt: async () => present(state.ci),
    getWorkflow: async () => present({ id: 10, path: ".github/workflows/ci.yml" }),
    listActionsRunJobs: async () => present(state.jobs),
    getCommitCheckRuns: async () => present(state.checks),
  }
  return { candidate, manifestSha256, run, git, github, files, state, authorization }
}
