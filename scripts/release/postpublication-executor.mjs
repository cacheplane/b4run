#!/usr/bin/env node

import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { snapshotJson } from "./adapter-normalize.mjs"
import { createGitReader } from "./adapters/git.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { isExactSemver } from "./semver.mjs"
import { parseWorkflowRecovery } from "./workflow-recovery.mjs"

const REPOSITORY = "cacheplane/b4run"
const REPOSITORY_ID = 1210070282
const RELEASE_WORKFLOW = ".github/workflows/release.yml"
const AUDIT_WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const MAX_WAIT_MS = 30 * 60 * 1000
const PENDING = new Set(["queued", "in_progress", "waiting", "pending", "requested"])
const PINS_PATH = "scripts/release/test/fixtures/release-script-hashes.json"
const SHA = /^[a-f0-9]{40}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const authorized = new WeakMap()
const positiveId = (value) => Number.isSafeInteger(value) && value > 0
const hash = (value) => createHash("sha256").update(value).digest("hex")
const requireThat = (value, message) => {
  if (!value) throw new Error(`Postpublication executor authority: ${message}`)
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
export function postpublicationExecutorIdentity({ candidate, executor }) {
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

export async function authorizePostpublicationExecutor({
  candidate,
  run,
  git,
  github,
  workflow = RELEASE_WORKFLOW,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
  timeoutMs = MAX_WAIT_MS,
  pollIntervalMs = 10_000,
}) {
  candidate = snapshotJson(candidate)
  run = snapshotJson(run)
  const expected = identity(candidate)
  if (run?.head_sha === expected.commitSha && run?.head_branch === `v${expected.version}`) {
    return seal(candidate, expected.commitSha, `v${expected.version}`)
  }
  requireThat(
    SHA.test(run?.head_sha) &&
      run?.head_branch === "main" &&
      ((workflow === RELEASE_WORKFLOW &&
        ["push", "schedule", "workflow_dispatch"].includes(run?.event)) ||
        (workflow === AUDIT_WORKFLOW && run?.event === "workflow_dispatch")) &&
      run?.path === workflow &&
      positiveId(run?.id) &&
      positiveId(run?.run_attempt) &&
      positiveId(run?.workflow_id) &&
      repo(run?.repository),
    "invalid main run identity",
  )
  requireThat(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= MAX_WAIT_MS &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs > 0 &&
      pollIntervalMs <= 60_000 &&
      typeof wait === "function" &&
      typeof now === "function",
    "invalid CI wait bounds",
  )
  const started = now()
  requireThat(Number.isFinite(started), "invalid clock")
  const deadline = started + timeoutMs
  const wallDeadline = performance.now() + timeoutMs
  let previous = started
  const remaining = () => {
    const current = now()
    requireThat(Number.isFinite(current) && current >= previous, "invalid or regressing clock")
    previous = current
    const budget = Math.min(deadline - current, wallDeadline - performance.now())
    requireThat(budget > 0, "CI timed out")
    return budget
  }
  const withinDeadline = async (operation) => {
    const budget = remaining()
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Postpublication executor authority: CI timed out")),
            Math.ceil(budget),
          )
        }),
      ])
      remaining()
      return result
    } finally {
      clearTimeout(timer)
    }
  }
  const sourceSha = run.head_sha
  const read = async (method, args) => {
    const envelope = snapshotJson(await withinDeadline(() => github[method](args)))
    requireThat(
      envelope?.status === "PRESENT" && Object.hasOwn(envelope, "value"),
      `${method} unavailable`,
    )
    return envelope.value
  }
  const show = async (path) => {
    const source = await withinDeadline(() => git.showFile({ ref: sourceSha, path }))
    requireThat(
      typeof source === "string" && Buffer.byteLength(source) <= 1024 * 1024,
      "invalid source bytes",
    )
    return source
  }
  const sourceWorkflow = await read("getWorkflow", {
    workflow: workflow.split("/").at(-1),
  })
  requireThat(
    sourceWorkflow.id === run.workflow_id && sourceWorkflow.path === workflow,
    "executor workflow changed",
  )
  await show(workflow)
  requireThat(
    (await withinDeadline(() =>
      git.isAncestor({
        ancestor: expected.commitSha,
        descendant: sourceSha,
      }),
    )) === true,
    "candidate is not an ancestor of executor",
  )
  const main = await read("getRef", { ref: "heads/main" })
  requireThat(
    main.ref === "refs/heads/main" && main.object?.type === "commit" && SHA.test(main.object?.sha),
    "invalid main ref",
  )
  const comparison = await read("compareCommits", { baseSha: sourceSha, headSha: main.object.sha })
  requireThat(
    comparison?.base_commit?.sha === sourceSha &&
      comparison?.merge_base_commit?.sha === sourceSha &&
      comparison.behind_by === 0 &&
      Number.isSafeInteger(comparison.ahead_by) &&
      comparison.total_commits === comparison.ahead_by &&
      ((main.object.sha === sourceSha &&
        comparison.status === "identical" &&
        comparison.ahead_by === 0) ||
        (main.object.sha !== sourceSha &&
          comparison.status === "ahead" &&
          comparison.ahead_by > 0)),
    "executor is not merged on main",
  )
  const pinBytes = await show(PINS_PATH)
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
  for (const name of [
    "postpublication-executor",
    "audit-executor",
    "independent-audit",
    "observe",
    "audit",
  ])
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
  let boundAttempt
  for (let polls = 0; ; polls++) {
    remaining()
    requireThat(polls <= Math.ceil(timeoutMs / pollIntervalMs), "CI timed out")
    const ciRuns = await read("listWorkflowRuns", {
      workflow: "ci.yml",
      commitSha: sourceSha,
    })
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
    requireThat(positiveId(listed.id) && positiveId(listed.run_attempt), "invalid CI attempt")
    if (boundAttempt === undefined) boundAttempt = { id: listed.id, attempt: listed.run_attempt }
    requireThat(
      listed.id === boundAttempt.id && listed.run_attempt === boundAttempt.attempt,
      "CI attempt changed while waiting",
    )
    const ci = await read("getActionsRunAttempt", {
      runId: listed.id,
      attempt: listed.run_attempt,
    })
    requireThat(
      repo(ci.repository) && positiveId(ci.workflow_id) && positiveId(ci.check_suite_id),
      "repository CI identity required",
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
    const ciWorkflow = await read("getWorkflow", { workflow: "ci.yml" })
    requireThat(
      positiveId(ciWorkflow.id) &&
        ciWorkflow.id === ci.workflow_id &&
        ciWorkflow.path === ".github/workflows/ci.yml",
      "CI workflow changed",
    )
    const pending = pendingOrSuccessful(ci, "CI")
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
      validateJobs.length <= 1 && validateChecks.length <= 1,
      "exact validate check required",
    )
    for (const job of validateJobs) {
      requireThat(positiveId(job.id), "invalid validate job identity")
      pendingOrSuccessful(job, "validate job")
    }
    for (const check of validateChecks) {
      requireThat(
        positiveId(check.id) &&
          positiveId(check.check_suite?.id) &&
          check.app?.slug === "github-actions",
        "invalid validate check identity",
      )
      pendingOrSuccessful(check, "validate check")
    }
    if (validateJobs.length === 1 && validateChecks.length === 1)
      requireThat(validateJobs[0].id === validateChecks[0].id, "validate IDs differ")
    if (!pending) {
      requireThat(
        validateJobs.length === 1 && validateChecks.length === 1,
        "exact validate check required",
      )
      requireThat(
        [validateJobs[0], validateChecks[0]].every(
          (value) => value.status === "completed" && value.conclusion === "success",
        ),
        "validate check unsuccessful",
      )
      remaining()
      return seal(candidate, sourceSha, "main")
    }
    const delay = Math.min(pollIntervalMs, remaining())
    await withinDeadline(() => wait(delay))
  }
}

function pendingOrSuccessful(value, label) {
  if (value.status === "completed") {
    requireThat(value.conclusion === "success", `${label} unsuccessful`)
    return false
  }
  requireThat(PENDING.has(value.status) && value.conclusion === null, `${label} malformed status`)
  return true
}

// This gate authorizes only postpublication execution; it cannot authorize npm
// publication or change the candidate/manifest recovered from the observation.
export async function runPostpublicationExecutorCli(argv, runtime = {}) {
  const values = new Map()
  requireThat(Array.isArray(argv) && argv.length === 4, "expected --report and --github-output")
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1]
    requireThat(
      ["--report", "--github-output"].includes(flag) &&
        !values.has(flag) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--") &&
        ![...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
      "invalid CLI argument",
    )
    values.set(flag, value)
  }
  const environment = runtime.environment ?? process.env
  const invocation = Object.fromEntries(
    [
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_OUTPUT",
    ].map((name) => [name, environment[name]]),
  )
  requireThat(
    invocation.GITHUB_REPOSITORY === REPOSITORY &&
      invocation.GITHUB_REPOSITORY_ID === String(REPOSITORY_ID) &&
      invocation.GITHUB_REF === "refs/heads/main" &&
      invocation.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/main` &&
      ["push", "schedule", "workflow_dispatch"].includes(invocation.GITHUB_EVENT_NAME) &&
      SHA.test(invocation.GITHUB_SHA) &&
      invocation.GITHUB_OUTPUT === values.get("--github-output"),
    "invalid GitHub invocation",
  )
  const number = (name) => {
    const value = invocation[name]
    requireThat(
      typeof value === "string" && /^[1-9][0-9]*$/u.test(value) && positiveId(Number(value)),
      `invalid ${name}`,
    )
    return Number(value)
  }
  const runId = number("GITHUB_RUN_ID"),
    attempt = number("GITHUB_RUN_ATTEMPT")
  const fileSystem = runtime.fileSystem ?? defaultFileSystem
  const bytes = await fileSystem.readFile(values.get("--report"), "utf8")
  requireThat(
    typeof bytes === "string" && Buffer.byteLength(bytes) <= 1024 * 1024,
    "invalid report bytes",
  )
  const recovered = parseWorkflowRecovery(JSON.parse(bytes))
  requireThat(
    [
      "run-release-smokes",
      "reconcile-smoke-evidence",
      "dispatch-release-audit",
      "complete-release-audit",
      "publish-github-release",
    ].includes(recovered.nextTransition),
    "transition is not postpublication",
  )
  const git = runtime.git ?? createGitReader({ root: process.cwd() })
  const github =
    runtime.github ??
    createGitHubReader({
      owner: "cacheplane",
      repo: "b4run",
      repositoryId: invocation.GITHUB_REPOSITORY_ID,
      token: environment.GITHUB_TOKEN,
    })
  const envelope = snapshotJson(await github.getActionsRunAttempt({ runId, attempt }))
  requireThat(
    envelope?.status === "PRESENT" && Object.hasOwn(envelope, "value"),
    "executor run unavailable",
  )
  const run = envelope.value
  requireThat(
    run?.id === runId &&
      run?.run_attempt === attempt &&
      run?.head_sha === invocation.GITHUB_SHA &&
      run?.head_branch === "main" &&
      run?.event === invocation.GITHUB_EVENT_NAME,
    "executor run does not match invocation",
  )
  const executor = await authorizePostpublicationExecutor({
    candidate: recovered.candidate,
    run,
    git,
    github,
    workflow: RELEASE_WORKFLOW,
  })
  await fileSystem.appendFile(
    values.get("--github-output"),
    `executor_sha=${executor.headSha}\n`,
    "utf8",
  )
  return executor
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPostpublicationExecutorCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
