// The software factory's CI guard (rung 4 spec §9): a pull request whose head branch is
// `factory/*`, or whose author is the factory app's bot, must never run a job that holds a
// secret, deploys to an environment, or can write to the repository. Its code is model
// output nobody has merged.
//
// The rule is generic on purpose. A job is guarded when its workflow can run on a pull
// request and the job (or a local reusable workflow it calls) references any secret other
// than GITHUB_TOKEN, names an environment, or is granted a write permission other than
// security-events. Each such job's `if:` must be DEFINITELY false for a factory pull request,
// evaluated three-valued: the test states only what a factory PR fixes (the event, the
// repository, the head ref and the author) and leaves every job output, status function and
// other property unknown, so a job that runs "only when an output is true" or "on failure()"
// is not called guarded. A new secret-bearing job therefore fails here until it carries the
// guard, instead of escaping a list of three names. Triggers are an allow-list: anything that
// could reach secrets for an event a pull request causes some other way is refused. The
// branch prefix and the bot login are the controller's
// (examples/software-factory/controller/src/lib/delivery/guard.json), passed in.

import { evaluateExpression } from "./github-expression.mjs"

const REPOSITORY = "cacheplane/b4run"

/** Write scopes a pull-request job may hold without the guard: code scanning's upload. */
const EXEMPT_WRITES = new Set(["security-events"])

/**
 * The only triggers a workflow may declare. `pull_request` runs the PR's code with the
 * guard; `push` only to main; the rest are started by a person or a schedule, never by a PR.
 * Everything else (`pull_request_target`, `workflow_run`, `repository_dispatch`,
 * `issue_comment`, `pull_request_review`, `create`, …) is refused: each can run with secrets
 * for an event a pull request, its author or `contents: write` causes, and several run with
 * `github.event.pull_request` null, which the guard reads.
 */
const ALLOWED_TRIGGERS = new Set([
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
  "workflow_call",
  "branch_protection_rule",
])

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

function triggers(workflow) {
  const on = workflow.on
  if (typeof on === "string") return { [on]: null }
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [name, null]))
  return isRecord(on) ? on : {}
}

function writes(permissions) {
  if (permissions === "write-all") return ["*"]
  if (!isRecord(permissions)) return []
  return Object.entries(permissions)
    .filter(([scope, level]) => level === "write" && !EXEMPT_WRITES.has(scope))
    .map(([scope]) => scope)
}

/** Every string anywhere in `value`, with the key it sits under. */
function* strings(value, key) {
  if (typeof value === "string") yield [key, value]
  else if (Array.isArray(value)) for (const item of value) yield* strings(item, key)
  else if (isRecord(value)) for (const [k, item] of Object.entries(value)) yield* strings(item, k)
}

/** A reference to the `secrets` context (not a property that happens to be called that). */
const SECRETS = /(?<![\w.-])secrets(?![\w-])/iu
/** The one secret a guarded job may read: the run's own read-only token. */
const GITHUB_TOKEN = /(?<![\w.-])secrets\s*\.\s*github_token(?![\w-])/giu

/**
 * Every reference to a secret other than `secrets.GITHUB_TOKEN`, as written. Each `${{ }}` in
 * every string is read (an `if:` is an expression whole), and ANY other use of the `secrets`
 * context counts, however it is spelled: `toJSON(secrets)`, `secrets[matrix.name]`,
 * `secrets[format(...)]` and `secrets` split from `.NAME` across lines name no secret a
 * pattern could list, so they are refused rather than read.
 */
function secretsReferenced(value) {
  const found = []
  for (const [key, text] of strings(value ?? null)) {
    const expressions =
      key === "if"
        ? [text]
        : [...text.matchAll(/\$\{\{([\s\S]*?)(?:\}\}|$)/gu)].map((match) => match[1])
    for (const expression of expressions) {
      const rest = expression.replace(GITHUB_TOKEN, "")
      if (SECRETS.test(rest)) found.push(expression.trim().replace(/\s+/gu, " "))
    }
  }
  return found
}

/** The file name of a local reusable workflow `job` calls, or undefined. */
function localCall(job) {
  const uses = typeof job.uses === "string" ? job.uses : undefined
  const match = uses === undefined ? null : /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/u.exec(uses)
  return match?.[1]
}

/**
 * Why `job` needs the guard, or an empty list when it does not. `workflows` resolves a local
 * reusable workflow the job calls: what its jobs hold, the caller holds.
 */
export function guardReasons(workflow, job, workflows = {}, seen = new Set()) {
  const reasons = []
  const secrets = [...new Set([...secretsReferenced(workflow.env), ...secretsReferenced(job)])]
  if (secrets.length > 0) reasons.push(`references secrets (${secrets.join("; ")})`)
  if (job.environment !== undefined) reasons.push("names an environment")
  if (job.uses !== undefined && job.secrets !== undefined)
    reasons.push("passes secrets to a reusable workflow")
  const granted = writes(job.permissions ?? workflow.permissions)
  if (granted.length > 0) reasons.push(`is granted ${granted.join(", ")}: write`)
  const called = localCall(job)
  if (job.uses !== undefined && called === undefined)
    reasons.push(`calls ${job.uses}, which this test cannot read`)
  if (called !== undefined && !seen.has(called)) {
    const target = workflows[called]
    if (!isRecord(target)) reasons.push(`calls ${called}, which does not exist`)
    else
      for (const [id, inner] of Object.entries(target.jobs ?? {}))
        for (const reason of guardReasons(target, inner, workflows, new Set([...seen, called])))
          reasons.push(`calls ${called}, whose job ${id} ${reason}`)
  }
  return reasons
}

/**
 * The `needs` context of a run in which every job of the workflow succeeded and every output
 * reads "false": a person's ordinary pull request, used only to show the guard does not stop
 * what it should not.
 */
function needsOf(jobs) {
  return Object.fromEntries(
    Object.entries(jobs ?? {}).map(([id, job]) => [
      id,
      {
        result: "success",
        outputs: Object.fromEntries(Object.keys(job?.outputs ?? {}).map((name) => [name, "false"])),
      },
    ]),
  )
}

/**
 * A same-repository pull request from `headRef` by `login`, every context known: for the
 * positive control (a person's PR still runs every guarded job).
 */
export function pullRequestContext(headRef, login, jobs = {}) {
  return {
    github: {
      event_name: "pull_request",
      repository: REPOSITORY,
      ref: "refs/pull/1/merge",
      head_ref: headRef,
      base_ref: "main",
      actor: login,
      event: {
        pull_request: {
          number: 1,
          user: { login },
          head: {
            ref: headRef,
            label: `cacheplane:${headRef}`,
            repo: { full_name: REPOSITORY },
          },
          base: { ref: "main" },
        },
      },
    },
    needs: needsOf(jobs),
    status: { always: true, success: true, failure: false, cancelled: false },
  }
}

/**
 * What a factory pull request fixes, and nothing more: the event, the repository, the head
 * ref (as `head.ref` and `head_ref`) and the author. Everything else is unknown.
 */
export function factoryContext(headRef, login) {
  return {
    unknownByDefault: true,
    github: {
      event_name: "pull_request",
      repository: REPOSITORY,
      head_ref: headRef,
      event: {
        pull_request: {
          user: { login },
          head: { ref: headRef, repo: { full_name: REPOSITORY } },
        },
      },
    },
    status: { always: true },
  }
}

/** Each way a factory pull request arrives, every one of which the guard must stop. */
export function factoryPullRequests({ branchPrefix, botLogin }) {
  return [
    ["the factory's own pull request", `${branchPrefix}wo-0123456789abcdef`, botLogin],
    ["a factory branch opened by a person", `${branchPrefix}wo-0123456789abcdef`, "blove"],
    ["the factory bot on another branch", "fix/something", botLogin],
  ]
}

/**
 * Every problem with the workflows' factory guard, as sentences; empty when the guard holds.
 * `workflows` maps a workflow file name to its parsed workflow object; `guard` is the
 * controller's guard.json (`branchPrefix`, `botLogin`).
 */
export function factoryGuardProblems(workflows, guard) {
  const problems = []
  for (const [file, workflow] of Object.entries(workflows)) {
    const on = triggers(workflow)
    for (const name of Object.keys(on))
      if (!ALLOWED_TRIGGERS.has(name))
        problems.push(
          `${file} listens on ${name}: only ${[...ALLOWED_TRIGGERS].join(", ")} are allowed, because anything else can run with secrets for an event a pull request causes`,
        )
    if (Object.hasOwn(on, "push")) {
      const push = isRecord(on.push) ? on.push : {}
      const branches = push.branches
      if (
        !Array.isArray(branches) ||
        branches.length !== 1 ||
        branches[0] !== "main" ||
        push["branches-ignore"] !== undefined ||
        push.tags !== undefined ||
        push["tags-ignore"] !== undefined
      )
        problems.push(
          `${file} runs on a push to a branch other than main: a push to factory/* must run nothing`,
        )
    }
    if (!Object.hasOwn(on, "pull_request")) continue
    if (workflow.permissions === undefined)
      problems.push(
        `${file} runs on pull_request with no top-level permissions block: its jobs would inherit the repository default`,
      )
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      if (!isRecord(job)) continue
      const reasons = guardReasons(workflow, job, workflows)
      if (reasons.length === 0) continue
      const where = `${file} job ${id} (${reasons.join("; ")})`
      if (job.if === undefined) {
        problems.push(`${where} has no if: and so runs for a factory pull request`)
        continue
      }
      for (const [label, headRef, login] of factoryPullRequests(guard)) {
        let runs
        try {
          runs = evaluateExpression(job.if, factoryContext(headRef, login))
        } catch (error) {
          problems.push(`${where}: its if: cannot be evaluated (${error.message})`)
          break
        }
        if (runs !== false)
          problems.push(
            `${where} ${runs === true ? "runs" : "may run"} for ${label}: its if: is not definitely false`,
          )
      }
    }
  }
  return problems
}
