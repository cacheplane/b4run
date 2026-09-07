import { createHash } from "node:crypto"
import { snapshotJson } from "./adapter-normalize.mjs"
import { isExactSemver } from "./semver.mjs"

const REPOSITORY = "cacheplane/dawnai"
const REPOSITORY_ID = 1210070282
const WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const PINS_PATH = "scripts/release/test/fixtures/release-script-hashes.json"
const SHA = /^[a-f0-9]{40}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const authorized = new WeakMap()
const positiveId = (value) => Number.isSafeInteger(value) && value > 0
const hash = (value) => createHash("sha256").update(value).digest("hex")
const requireThat = (value, message) => {
  if (!value) throw new Error(`Audit executor authority: ${message}`)
}
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" ")
const repo = (value) => value?.id === REPOSITORY_ID && value?.full_name === REPOSITORY

function identity(candidate) {
  requireThat(
    isExactSemver(candidate?.version) && SHA.test(candidate?.commitSha),
    "invalid candidate",
  )
  return { version: candidate.version, commitSha: candidate.commitSha }
}
function seal(candidate, headSha, headBranch) {
  const result = Object.freeze({ headSha, headBranch })
  authorized.set(result, identity(candidate))
  return result
}

// No caller-supplied object can widen the legacy candidate/tag identity. The main
// identity is available only after the immutable source and GitHub CI reads below.
export function auditExecutorIdentity({ candidate, executor }) {
  const expected = identity(candidate)
  if (executor === undefined)
    return { headSha: expected.commitSha, headBranch: `v${expected.version}` }
  const bound = authorized.get(executor)
  requireThat(
    bound?.version === expected.version && bound?.commitSha === expected.commitSha,
    "unverified or mismatched executor",
  )
  return executor
}

export async function authorizeAuditExecutor({ candidate, manifestSha256, run, git, github }) {
  const expected = identity(candidate)
  if (run?.head_sha === expected.commitSha && run?.head_branch === `v${expected.version}`) {
    return seal(candidate, expected.commitSha, `v${expected.version}`)
  }
  requireThat(
    SHA.test(run?.head_sha) &&
      run?.head_branch === "main" &&
      run?.event === "workflow_dispatch" &&
      run?.path === WORKFLOW &&
      repo(run?.repository),
    "invalid main run identity",
  )
  requireThat(DIGEST.test(manifestSha256), "manifest digest required")
  const sourceSha = run.head_sha
  const read = async (method, args) => {
    const envelope = snapshotJson(await github[method](args))
    requireThat(
      envelope?.status === "PRESENT" && Object.hasOwn(envelope, "value"),
      `${method} unavailable`,
    )
    return envelope.value
  }
  const show = async (path) => {
    const source = await git.showFile({ ref: sourceSha, path })
    requireThat(
      typeof source === "string" && Buffer.byteLength(source) <= 1024 * 1024,
      "invalid source bytes",
    )
    return source
  }
  const main = await read("getRef", { ref: "heads/main" })
  requireThat(
    main.ref === "refs/heads/main" && main.object?.type === "commit" && SHA.test(main.object?.sha),
    "invalid main ref",
  )
  requireThat(
    (await git.isAncestor({ ancestor: sourceSha, descendant: main.object.sha })) === true,
    "executor is not merged on main",
  )
  const record = snapshotJson(
    JSON.parse(
      await show(`scripts/release/audit-executor-authorizations/v${expected.version}.json`),
    ),
  )
  requireThat(
    exact(record, "schemaVersion repository candidate workflow workflowSha256 scriptPinsSha256") &&
      record.schemaVersion === 1 &&
      record.repository === REPOSITORY &&
      record.workflow === WORKFLOW &&
      DIGEST.test(record.workflowSha256) &&
      DIGEST.test(record.scriptPinsSha256),
    "invalid source authorization",
  )
  requireThat(
    exact(record.candidate, "version commitSha manifestSha256") &&
      record.candidate.version === expected.version &&
      record.candidate.commitSha === expected.commitSha &&
      record.candidate.manifestSha256 === manifestSha256,
    "authorization does not match candidate",
  )
  requireThat(hash(await show(WORKFLOW)) === record.workflowSha256, "workflow source changed")
  const pinBytes = await show(PINS_PATH)
  requireThat(hash(pinBytes) === record.scriptPinsSha256, "verifier pins changed")
  const pins = snapshotJson(JSON.parse(pinBytes))
  requireThat(
    exact(pins, "schemaVersion scripts") &&
      pins.schemaVersion === 1 &&
      pins.scripts &&
      typeof pins.scripts === "object" &&
      !Array.isArray(pins.scripts),
    "invalid verifier pins",
  )
  const entries = Object.entries(pins.scripts)
  requireThat(entries.length > 0 && entries.length <= 512, "invalid verifier input count")
  for (const name of ["audit-executor", "independent-audit", "observe", "audit"])
    requireThat(
      Object.hasOwn(pins.scripts, `scripts/release/${name}.mjs`),
      "missing required verifier input",
    )
  for (const [path, pin] of entries) {
    requireThat(
      /^scripts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:mjs|json)$/u.test(path) &&
        !path.includes("..") &&
        exact(pin, "sha256") &&
        DIGEST.test(pin.sha256),
      "invalid pinned source",
    )
    requireThat(hash(await show(path)) === pin.sha256, `pinned source changed: ${path}`)
  }
  const ciRuns = await read("listWorkflowRuns", { workflow: "ci.yml", commitSha: sourceSha })
  requireThat(Array.isArray(ciRuns), "CI list unavailable")
  const matches = ciRuns.filter(
    (ci) =>
      ci?.head_sha === sourceSha &&
      ci?.head_branch === "main" &&
      ci?.event === "push" &&
      ci?.path === ".github/workflows/ci.yml",
  )
  requireThat(matches.length === 1, "one exact main CI run required")
  const listed = matches[0]
  requireThat(
    Number.isSafeInteger(listed.id) &&
      listed.id > 0 &&
      Number.isSafeInteger(listed.run_attempt) &&
      listed.run_attempt > 0,
    "invalid CI attempt",
  )
  const ci = await read("getActionsRunAttempt", { runId: listed.id, attempt: listed.run_attempt })
  requireThat(
    repo(ci.repository) &&
      positiveId(ci.workflow_id) &&
      positiveId(ci.check_suite_id) &&
      ci.status === "completed" &&
      ci.conclusion === "success",
    "successful repository CI required",
  )
  for (const key of [
    "id",
    "run_attempt",
    "head_sha",
    "head_branch",
    "event",
    "path",
    "workflow_id",
    "check_suite_id",
  ])
    requireThat(ci[key] === listed[key], "CI exact reread changed")
  const workflow = await read("getWorkflow", { workflow: "ci.yml" })
  requireThat(
    positiveId(workflow.id) &&
      workflow.id === ci.workflow_id &&
      workflow.path === ".github/workflows/ci.yml",
    "CI workflow changed",
  )
  const [jobs, checks] = await Promise.all([
    read("listActionsRunJobs", { runId: ci.id }),
    read("getCommitCheckRuns", { commitSha: sourceSha }),
  ])
  requireThat(Array.isArray(jobs) && Array.isArray(checks), "CI checks unavailable")
  const validateJobs = jobs.filter(
    (job) => job?.name === "validate" && job.runAttempt === ci.run_attempt,
  )
  const validateChecks = checks.filter(
    (check) =>
      check?.name === "validate" &&
      check.head_sha === sourceSha &&
      check.check_suite?.id === ci.check_suite_id,
  )
  requireThat(
    validateJobs.length === 1 && validateChecks.length === 1,
    "exact validate check required",
  )
  const job = validateJobs[0],
    check = validateChecks[0]
  requireThat(
    positiveId(job.id) &&
      positiveId(check.id) &&
      positiveId(check.check_suite?.id) &&
      job.id === check.id &&
      check.app?.slug === "github-actions" &&
      [job, check].every((value) => value.status === "completed" && value.conclusion === "success"),
    "validate check unsuccessful",
  )
  return seal(candidate, sourceSha, "main")
}
