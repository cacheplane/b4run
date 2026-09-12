import assert from "node:assert/strict"
import test from "node:test"
import { postpublicationExecutorFixture } from "./support/postpublication-executor-fixture.mjs"

const load = async () => {
  try {
    return await import("../postpublication-executor.mjs")
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {}
    throw error
  }
}

test("reviewed main source authorizes an ancestor candidate without per-version records", async () => {
  const module = await load()
  assert.equal(typeof module.authorizePostpublicationExecutor, "function")
  const f = postpublicationExecutorFixture()
  f.files.delete(`scripts/release/audit-executor-authorizations/v${f.candidate.version}.json`)
  const ancestry = []
  f.git.isAncestor = async (args) => {
    ancestry.push(args)
    return true
  }
  const executor = await module.authorizePostpublicationExecutor(f)
  assert.deepEqual(
    module.postpublicationExecutorIdentity({
      candidate: f.candidate,
      executor,
    }),
    {
      headSha: f.run.head_sha,
      headBranch: "main",
    },
  )
  assert.deepEqual(ancestry, [{ ancestor: f.candidate.commitSha, descendant: f.run.head_sha }])
  assert.throws(() =>
    module.postpublicationExecutorIdentity({
      candidate: f.candidate,
      executor: { ...executor },
    }),
  )
  assert.throws(() =>
    module.postpublicationExecutorIdentity({
      candidate: { ...f.candidate, commitSha: "7".repeat(40) },
      executor,
    }),
  )
})

for (const event of ["push", "schedule", "workflow_dispatch"])
  test(`release main supports ${event}`, async () => {
    const f = postpublicationExecutorFixture()
    f.run.event = event
    await (await load()).authorizePostpublicationExecutor(f)
  })

for (const [name, mutate] of Object.entries({
  "wrong candidate ancestry": (f) => {
    f.git.isAncestor = async ({ ancestor }) => ancestor !== f.candidate.commitSha
  },
  "unmerged executor": (f) => {
    f.state.comparison.merge_base_commit.sha = "7".repeat(40)
  },
  "wrong repository name": (f) => {
    f.run.repository.full_name = "cacheplane/dawnai"
  },
  "wrong repository id": (f) => {
    f.run.repository.id = 1
  },
  "untrusted event": (f) => {
    f.run.event = "pull_request_target"
  },
  "wrong branch": (f) => {
    f.run.head_branch = "feature"
  },
  "wrong workflow path": (f) => {
    f.run.path = ".github/workflows/other.yml"
  },
  "wrong workflow id": (f) => {
    f.run.workflow_id = 99
  },
  "unsupported workflow argument": (f) => {
    f.workflow = f.run.path = ".github/workflows/other.yml"
  },
  "independent audit schedule": (f) => {
    f.workflow = f.run.path = ".github/workflows/published-artifact-verify.yml"
    f.run.event = "schedule"
  },
  "absent generic authority pin": (f) => {
    const key = "scripts/release/test/fixtures/release-script-hashes.json"
    const pins = JSON.parse(f.files.get(key))
    delete pins.scripts["scripts/release/postpublication-executor.mjs"]
    f.files.set(key, JSON.stringify(pins))
  },
  "changed pinned authority": (f) => {
    f.files.set("scripts/release/postpublication-executor.mjs", "changed")
  },
  "malformed pins": (f) => {
    f.files.set("scripts/release/test/fixtures/release-script-hashes.json", "{}")
  },
  "failed CI": (f) => {
    f.state.ci.conclusion = "failure"
  },
  "malformed CI status": (f) => {
    f.state.ci.status = "unknown"
  },
  "wrong CI SHA": (f) => {
    f.state.ci.head_sha = "9".repeat(40)
  },
  "foreign CI repository": (f) => {
    f.state.ci.repository = { id: 1, full_name: "other/repo" }
  },
  "missing CI identifiers": (f) => {
    delete f.state.ci.workflow_id
    delete f.state.ci.check_suite_id
  },
  "changed CI exact attempt": (f) => {
    f.github.getActionsRunAttempt = async () => ({
      status: "PRESENT",
      value: { ...f.state.ci, run_attempt: 2 },
    })
  },
  "ambiguous CI": (f) => {
    f.github.listWorkflowRuns = async () => ({
      status: "PRESENT",
      value: [f.state.ci, { ...f.state.ci, id: 602 }],
    })
  },
  "missing completed validate": (f) => {
    f.state.jobs = []
  },
  "duplicate validate": (f) => {
    f.state.jobs.push({ ...f.state.jobs[0], id: 702 })
  },
  "wrong validate attempt": (f) => {
    f.state.jobs[0].runAttempt = 2
  },
  "foreign validate app": (f) => {
    f.state.checks[0].app.slug = "foreign"
  },
  "unmatched validate ids": (f) => {
    f.state.jobs[0].id = 702
  },
  "missing validate ids": (f) => {
    delete f.state.jobs[0].id
    delete f.state.checks[0].id
  },
  "failed validate while CI running": (f) => {
    f.state.ci.status = "in_progress"
    f.state.ci.conclusion = null
    f.state.jobs[0].conclusion = "failure"
  },
}))
  test(`rejects ${name} without retrying`, async () => {
    const f = postpublicationExecutorFixture()
    mutate(f)
    let waits = 0
    await assert.rejects(
      (await load()).authorizePostpublicationExecutor({
        ...f,
        wait: async () => {
          waits++
          throw new Error("unexpected retry")
        },
      }),
    )
    assert.equal(waits, 0)
  })

test("waits for running CI even before validate appears, then binds the same executor", async () => {
  const f = postpublicationExecutorFixture()
  const jobs = f.state.jobs,
    checks = f.state.checks
  f.state.ci.status = "in_progress"
  f.state.ci.conclusion = null
  f.state.jobs = []
  f.state.checks = []
  let time = 0,
    waits = 0
  const executor = await (await load()).authorizePostpublicationExecutor({
    ...f,
    now: () => time,
    timeoutMs: 100,
    pollIntervalMs: 10,
    wait: async (ms) => {
      time += ms
      waits++
      f.state.ci.status = "completed"
      f.state.ci.conclusion = "success"
      f.state.jobs = jobs
      f.state.checks = checks
    },
  })
  assert.equal(waits, 1)
  assert.equal(executor.headSha, f.run.head_sha)
})

test("pending CI reaches a bounded deadline", async () => {
  const f = postpublicationExecutorFixture()
  f.state.ci.status = "queued"
  f.state.ci.conclusion = null
  f.state.jobs = []
  f.state.checks = []
  let time = 0
  await assert.rejects(
    (await load()).authorizePostpublicationExecutor({
      ...f,
      now: () => time,
      timeoutMs: 20,
      pollIntervalMs: 10,
      wait: async (ms) => {
        time += ms
      },
    }),
    /timed out/,
  )
  assert.equal(time, 20)
})

test("tag candidate retains exact legacy identity without main authority reads", async () => {
  const f = postpublicationExecutorFixture()
  f.run = {
    head_sha: f.candidate.commitSha,
    head_branch: `v${f.candidate.version}`,
  }
  const module = await load()
  const executor = await module.authorizePostpublicationExecutor({
    candidate: f.candidate,
    run: f.run,
  })
  assert.deepEqual(
    module.postpublicationExecutorIdentity({
      candidate: f.candidate,
      executor,
    }),
    { headSha: f.candidate.commitSha, headBranch: `v${f.candidate.version}` },
  )
})

async function cliFixture() {
  const { postpublicationReportFixture } = await import(
    "./support/postpublication-report-fixture.mjs"
  )
  const report = postpublicationReportFixture({
    state: "RELEASE_DRAFT_COMPLETE",
    transition: "run-release-smokes",
    npm: true,
  })
  const f = postpublicationExecutorFixture({ candidate: report.candidate })
  const environment = {
    GITHUB_REPOSITORY: "cacheplane/b4run",
    GITHUB_REPOSITORY_ID: "1210070282",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "cacheplane/b4run/.github/workflows/release.yml@refs/heads/main",
    GITHUB_SHA: f.run.head_sha,
    GITHUB_RUN_ID: String(f.run.id),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: "/tmp/executor-output",
    GITHUB_TOKEN: "test-token",
  }
  const writes = []
  const getAttempt = f.github.getActionsRunAttempt
  f.github.getActionsRunAttempt = async (args) =>
    args.runId === f.run.id ? { status: "PRESENT", value: f.run } : getAttempt(args)
  const fileSystem = {
    readFile: async () => JSON.stringify(report),
    appendFile: async (...args) => writes.push(args),
  }
  return { ...f, report, environment, writes, fileSystem }
}

test("CLI binds dry observation and actual main run before writing immutable executor output", async () => {
  const module = await load()
  assert.equal(typeof module.runPostpublicationExecutorCli, "function")
  const f = await cliFixture()
  await module.runPostpublicationExecutorCli(
    ["--report", "report.json", "--github-output", f.environment.GITHUB_OUTPUT],
    f,
  )
  assert.deepEqual(f.writes, [
    [f.environment.GITHUB_OUTPUT, `executor_sha=${f.run.head_sha}\n`, "utf8"],
  ])
})
for (const [name, mutate] of Object.entries({
  "wrong env repository": (f) => {
    f.environment.GITHUB_REPOSITORY = "cacheplane/dawnai"
  },
  "wrong env repository id": (f) => {
    f.environment.GITHUB_REPOSITORY_ID = "1"
  },
  "wrong env SHA": (f) => {
    f.environment.GITHUB_SHA = "9".repeat(40)
  },
  "wrong env attempt": (f) => {
    f.environment.GITHUB_RUN_ATTEMPT = "2"
  },
  "wrong workflow ref": (f) => {
    f.environment.GITHUB_WORKFLOW_REF =
      "cacheplane/b4run/.github/workflows/other.yml@refs/heads/main"
  },
  "tag invocation": (f) => {
    f.environment.GITHUB_REF = `refs/tags/v${f.candidate.version}`
  },
  diagnostics: (f) => {
    f.report.diagnostics = [{ code: "untrusted" }]
  },
  "candidate mismatch": (f) => {
    f.report.candidate.commitSha = "9".repeat(40)
  },
  "manifest mismatch": (f) => {
    f.report.recovery.manifest.commitSha = "9".repeat(40)
  },
  "publisher transition": (f) => {
    f.report.before.plan.state = "CANDIDATE_ESCROWED"
    f.report.before.plan.nextTransition = f.report.transition.name = "publish-npm-packages"
  },
}))
  test(`CLI rejects ${name} without writing output`, async () => {
    const f = await cliFixture()
    mutate(f)
    await assert.rejects(
      (await load()).runPostpublicationExecutorCli(
        ["--report", "report.json", "--github-output", f.environment.GITHUB_OUTPUT],
        f,
      ),
    )
    assert.equal(f.writes.length, 0)
  })

test("main may advance to a remote commit absent from the local checkout", async () => {
  const f = postpublicationExecutorFixture()
  const comparisons = []
  f.git.isAncestor = async ({ ancestor, descendant }) => {
    assert.equal(ancestor, f.candidate.commitSha)
    assert.equal(descendant, f.run.head_sha, "remote main is not available locally")
    return true
  }
  f.github.compareCommits = async (args) => {
    comparisons.push(args)
    return { status: "PRESENT", value: f.state.comparison }
  }
  const executor = await (await load()).authorizePostpublicationExecutor(f)
  assert.equal(executor.headSha, f.run.head_sha)
  assert.deepEqual(comparisons, [{ baseSha: f.run.head_sha, headSha: "6".repeat(40) }])
})

for (const [name, mutate] of Object.entries({
  "wrong base": (f) => {
    f.state.comparison.base_commit.sha = "9".repeat(40)
  },
  "wrong merge base": (f) => {
    f.state.comparison.merge_base_commit.sha = "9".repeat(40)
  },
  diverged: (f) => {
    f.state.comparison.status = "diverged"
  },
  behind: (f) => {
    f.state.comparison.behind_by = 1
  },
  "negative ahead": (f) => {
    f.state.comparison.ahead_by = -1
  },
  "false identical": (f) => {
    f.state.comparison.status = "identical"
  },
  "inconsistent total": (f) => {
    f.state.comparison.total_commits = 2
  },
}))
  test(`rejects remote main comparison ${name}`, async () => {
    const f = postpublicationExecutorFixture()
    mutate(f)
    await assert.rejects((await load()).authorizePostpublicationExecutor(f))
  })

test("identical current main is verified with an exact remote comparison", async () => {
  const f = postpublicationExecutorFixture()
  f.github.getRef = async () => ({
    status: "PRESENT",
    value: { ref: "refs/heads/main", object: { type: "commit", sha: f.run.head_sha } },
  })
  Object.assign(f.state.comparison, { status: "identical", ahead_by: 0, total_commits: 0 })
  await (await load()).authorizePostpublicationExecutor(f)
})

test("CI success received after the authority deadline cannot seal an executor", async () => {
  const f = postpublicationExecutorFixture()
  let time = 0
  f.github.getCommitCheckRuns = async () => {
    time = 101
    return { status: "PRESENT", value: f.state.checks }
  }
  await assert.rejects(
    (await load()).authorizePostpublicationExecutor({ ...f, now: () => time, timeoutMs: 100 }),
    /timed out/,
  )
})

test("never-settling source reads are bounded by the authority deadline", async () => {
  const f = postpublicationExecutorFixture()
  f.git.showFile = async () => new Promise(() => {})
  await assert.rejects(
    (await load()).authorizePostpublicationExecutor({ ...f, timeoutMs: 20 }),
    /timed out/,
  )
})

test("a regressing clock cannot extend the authority deadline", async () => {
  const f = postpublicationExecutorFixture()
  let time = 100
  f.github.getCommitCheckRuns = async () => {
    time = 99
    return { status: "PRESENT", value: f.state.checks }
  }
  await assert.rejects(
    (await load()).authorizePostpublicationExecutor({ ...f, now: () => time, timeoutMs: 100 }),
    /clock/,
  )
})
