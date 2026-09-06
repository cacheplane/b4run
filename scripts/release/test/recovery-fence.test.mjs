import assert from "node:assert/strict"
import test from "node:test"
import { canonical, fenceEvidenceFixture } from "./support/recovery-fence-fixture.mjs"

test("extended fence evidence derives all 36 cases from explicit recorded calls", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  assert.equal(
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    }).cases.length,
    36,
  )
})
for (const [name, damage] of Object.entries({
  "old summary ledger": (f) => {
    f.evidence = {
      observations: Array(12).fill({ accepted: false, unchanged: true }),
    }
  },
  "missing matrix cell": (f) => {
    f.evidence.cases.pop()
  },
  "production repo": (f) => {
    f.evidence.repository = "cacheplane/dawnai"
  },
  "production ID": (f) => {
    f.evidence.repositoryId = "1210070282"
  },
  "accepted disabled request": (f) => {
    const c = f.evidence.cases.find((c) => c.stage === "disabled")
    f.evidence.calls.find((x) => x.id === c.requestCall).status = 201
  },
  "missing settlement": (f) => {
    const c = f.evidence.cases.find((c) => c.stage === "disabled")
    const call = f.evidence.calls.find((x) => x.id === c.afterInventoryCalls[0])
    call.startedAt = f.evidence.calls.find((x) => x.id === c.requestCall).finishedAt
  },
  "writer startup failure": (f) => {
    const c = f.evidence.cases[0]
    f.evidence.calls.find((x) => x.id === c.jobsAfterCall).response.jobs[0].steps[0].status =
      "skipped"
  },
  "wrong historical rerun lineage": (f) => {
    const c = f.evidence.cases.find((c) => c.context === "historical" && c.method === "all")
    f.evidence.calls.find((x) => x.id === c.targetRunCall).response.head_branch = "fence-historical"
  },
  "filtered inventory": (f) => {
    const c = f.evidence.cases[0]
    f.evidence.calls.find((x) => x.id === c.beforeInventoryCalls[0]).path +=
      `&head_sha=${f.evidence.currentSha}`
  },
  "truncated inventory": (f) => {
    const c = f.evidence.cases[0]
    f.evidence.calls.find((x) => x.id === c.beforeInventoryCalls[0]).response.total_count++
  },
  "wrong dispatch ID": (f) => {
    const c = f.evidence.cases[0]
    f.evidence.calls.find((x) => x.id === c.requestCall).response.workflow_run_id++
  },
  "missing restoration": (f) => {
    f.evidence.restoration.finalInventoryCalls = []
  },
  "production call": (f) => {
    f.evidence.calls[0].path = "/repos/cacheplane/dawnai"
  },
  "fixture mismatch": (f) => {
    f.fixtureBytes.current += "# changed\n"
  },
}))
  test(`extended fence evidence blocks ${name}`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture()
    damage(f)
    assert.throws(() =>
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    )
  })

async function runtimeFixture() {
  const { readFile } = await import("node:fs/promises")
  const { digest, historicalFixturePath, currentFixturePath } = await import(
    "./support/recovery-fence-fixture.mjs"
  )
  const f = await fenceEvidenceFixture()
  const controllerSha = "d".repeat(40),
    sourceSha = "a".repeat(40),
    defaultSha = "e".repeat(40)
  const { candidate: candidateFixture } = await import("./support/recovery-fixture.mjs")
  const candidate = {
    ...candidateFixture(),
    repositoryId: "1210070282",
    candidateSha: sourceSha,
  }
  const executor = {
    controllerSha,
    workflow: ".github/workflows/release-postpublication.yml",
    runId: "900",
    runAttempt: "1",
    jobId: "901",
    verifierClosureSha256: "f".repeat(64),
  }
  const { RECOVERY_FENCE_PROBE_INPUTS } = await import("../recovery/fence.mjs")
  const probeBytes = "// reviewed probe\n"
  const probeClosure = RECOVERY_FENCE_PROBE_INPUTS.map((path) => ({
    path,
    sha256: digest(probeBytes),
  }))
  f.evidence.probeClosureSha256 = digest(canonical(probeClosure))
  const evidenceBytes = canonical(f.evidence),
    evidenceSha256 = digest(evidenceBytes)
  const files = new Map()
  const put = (ref, path, raw) => files.set(`${ref}:${path}`, String(raw))
  for (const input of probeClosure) put(controllerSha, input.path, probeBytes)
  put(controllerSha, historicalFixturePath, f.fixtureBytes.historical)
  put(controllerSha, currentFixturePath, f.fixtureBytes.current)
  const sources = (workflow) => {
    const bytes = `name: ${workflow}\n`
    put(sourceSha, workflow, bytes)
    put(defaultSha, workflow, bytes)
    return [
      {
        source: { kind: "commit", sha: sourceSha },
        workflowSha256: digest(bytes),
        executionInputs: [],
      },
      {
        source: { kind: "current-default" },
        workflowSha256: digest(bytes),
        executionInputs: [],
      },
    ]
  }
  const topology = [
    {
      workflowId: "1",
      workflow: ".github/workflows/published-artifact-verify.yml",
      disposition: "fenced-legacy",
      sources: sources(".github/workflows/published-artifact-verify.yml"),
    },
    {
      workflowId: "2",
      workflow: ".github/workflows/release.yml",
      disposition: "fenced-legacy",
      sources: sources(".github/workflows/release.yml"),
    },
    {
      workflowId: "3",
      workflow: ".github/workflows/release-postpublication.yml",
      disposition: "recovery-owner",
      sources: [],
    },
    {
      workflowId: "4",
      workflow: ".github/workflows/release-postpublication-audit.yml",
      disposition: "recovery-audit",
      sources: [],
    },
    {
      workflowId: "5",
      workflow: ".github/workflows/ci.yml",
      disposition: "nonwriter",
      sources: sources(".github/workflows/ci.yml").slice(1),
    },
  ].sort((a, b) => a.workflow.localeCompare(b.workflow))
  const contract = {
    schemaVersion: 1,
    kind: "recovery-legacy-fence-contract",
    repository: candidate.repository,
    repositoryId: candidate.repositoryId,
    candidateSourceSha: sourceSha,
    mechanism: "github-workflow-disable-v1",
    apiVersion: "2026-03-10",
    evidenceSha256,
    probeClosure,
    fixtures: [
      {
        revision: "current",
        path: currentFixturePath,
        sha256: digest(f.fixtureBytes.current),
      },
      {
        revision: "historical",
        path: historicalFixturePath,
        sha256: digest(f.fixtureBytes.historical),
      },
    ],
    topology,
  }
  const contractBytes = canonical(contract),
    contractSha256 = digest(contractBytes)
  put(
    controllerSha,
    `scripts/release/recovery-fence-contracts/${contractSha256}.json`,
    contractBytes,
  )
  put(
    controllerSha,
    `scripts/release/recovery-fence-evidence/${evidenceSha256}.json`,
    evidenceBytes,
  )
  const policy = JSON.parse(await readFile("scripts/release/recovery/policy.json", "utf8"))
  policy.status = "ADMITTED"
  policy.fence.contracts = [contractSha256]
  const { hashVerifierClosure } = await import("../recovery/policy.mjs")
  for (const path of policy.verifierClosure.inputs)
    if (!files.has(`${controllerSha}:${path}`)) put(controllerSha, path, "// verifier source\n")
  policy.verifierClosure.sha256 = await hashVerifierClosure(
    { controllerSha, inputs: policy.verifierClosure.inputs },
    async ({ ref, path }) => files.get(`${ref}:${path}`),
  )
  executor.verifierClosureSha256 = policy.verifierClosure.sha256
  put(controllerSha, "scripts/release/recovery/policy.json", canonical(policy))
  const policySha256 = digest(canonical(policy)),
    calls = []
  const values = {
    getRepository: {
      id: 1210070282,
      full_name: candidate.repository,
      default_branch: "main",
    },
    getRef: {
      ref: "refs/heads/main",
      object: { type: "commit", sha: defaultSha },
    },
    listRepositoryWorkflowsComplete: topology.map((t) => ({
      id: Number(t.workflowId),
      path: t.workflow,
      state: t.disposition === "fenced-legacy" ? "disabled_manually" : "active",
    })),
  }
  const github = {
    ...Object.fromEntries(
      Object.keys(values).map((name) => [
        name,
        async (...args) => {
          calls.push([name, ...args])
          return { status: "PRESENT", value: structuredClone(values[name]) }
        },
      ]),
    ),
    async getWorkflowById({ workflowId }) {
      calls.push(["getWorkflowById", workflowId])
      return {
        status: "PRESENT",
        value: structuredClone(
          values.listRepositoryWorkflowsComplete.find((w) => String(w.id) === workflowId),
        ),
      }
    },
    async listWorkflowRunsAllShasComplete(args) {
      calls.push(["listWorkflowRunsAllShasComplete", args])
      return { status: "PRESENT", value: [] }
    },
  }
  const git = {
    async isAncestor() {
      return true
    },
    async showFile({ ref, path }) {
      calls.push(["showFile", ref, path])
      const raw = files.get(`${ref}:${path}`)
      if (raw === undefined) throw new Error("missing git bytes")
      return raw
    },
  }
  return {
    f,
    candidate,
    executor,
    policySha256,
    files,
    values,
    github,
    git,
    contract,
    contractSha256,
    controllerSha,
    sourceSha,
    defaultSha,
    put,
    calls,
    policy,
  }
}
test("production fence verifies reviewed bytes and double all-SHA drainage with original freshness", async () => {
  const subject = await import("../recovery/fence.mjs")
  const f = await runtimeFixture()
  let now = 1000
  const reader = subject.createRecoveryFenceReader({
    github: f.github,
    git: f.git,
    now: () => now++,
  })
  const result = await reader.observeLegacyFence({
    candidate: f.candidate,
    executor: f.executor,
    policySha256: f.policySha256,
  })
  assert.equal(result.contractSha256, f.contractSha256)
  assert.equal(result.observedAt, 1000)
  assert.equal(result.expiresAt, 31000)
  assert.equal(result.inventoryComplete, true)
  assert.equal(result.writers.length, 4)
  assert.equal(f.calls.filter((c) => c[0] === "listWorkflowRunsAllShasComplete").length, 4)
  assert.equal(f.calls.filter((c) => c[0] === "listRepositoryWorkflowsComplete").length, 2)
})
for (const [name, damage] of Object.entries({
  "unknown workflow": (f) =>
    f.values.listRepositoryWorkflowsComplete.push({
      id: 99,
      path: ".github/workflows/unknown.yml",
      state: "active",
    }),
  "active legacy writer": (f) => {
    f.values.listRepositoryWorkflowsComplete.find((x) => x.id === 2).state = "active"
  },
  "default branch mismatch": (f) => {
    f.values.getRepository.default_branch = "other"
  },
  "changed current bytes": (f) => f.put(f.defaultSha, ".github/workflows/ci.yml", "changed"),
  "missing reviewed evidence": (f) =>
    f.files.delete(
      `${f.controllerSha}:scripts/release/recovery-fence-evidence/${f.contract.evidenceSha256}.json`,
    ),
  "policy digest mismatch": (f) => {
    f.policySha256 = "0".repeat(64)
  },
  "nonterminal run": (f) => {
    f.github.listWorkflowRunsAllShasComplete = async () => ({
      status: "PRESENT",
      value: [{ id: 1, run_attempt: 1, status: "queued", conclusion: null }],
    })
  },
}))
  test(`production fence blocks ${name}`, async () => {
    const subject = await import("../recovery/fence.mjs")
    const f = await runtimeFixture()
    damage(f)
    await assert.rejects(() =>
      subject
        .createRecoveryFenceReader({
          github: f.github,
          git: f.git,
          now: () => 1000,
        })
        .observeLegacyFence({
          candidate: f.candidate,
          executor: f.executor,
          policySha256: f.policySha256,
        }),
    )
  })

test("proof projection retains selected raw witnesses and tolerates documented ref metadata", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  for (const c of f.evidence.calls)
    if (c.path.includes("/git/ref/")) {
      c.response.node_id = "MDM6UmVm"
      c.response.url = `https://api.github.com${c.path}`
      c.response.object.url = `https://api.github.com/repos/${f.evidence.repository}/git/commits/${c.response.object.sha}`
    }
  const { calls, ...witness } = f.evidence
  const rawCalls = [
    ...calls,
    {
      id: "poll-1",
      method: "GET",
      path: `/repos/${f.evidence.repository}/actions/runs/101`,
      response: { status: "in_progress" },
    },
  ]
  const projected = subject.projectRecoveryFenceEvidence(rawCalls, witness, {
    fixtureBytes: f.fixtureBytes,
    probeClosureSha256: f.evidence.probeClosureSha256,
  })
  assert.equal(projected.calls.length, calls.length)
  assert.ok(!projected.calls.some((c) => c.id === "poll-1"))
})
test("fence start time cannot become fresh after a long source read", async () => {
  const subject = await import("../recovery/fence.mjs"),
    f = await runtimeFixture()
  let clock = 1000
  const show = f.git.showFile
  f.git.showFile = async (args) => {
    const raw = await show(args)
    clock += 31000
    return raw
  }
  await assert.rejects(
    () =>
      subject
        .createRecoveryFenceReader({
          github: f.github,
          git: f.git,
          now: () => clock,
        })
        .observeLegacyFence({
          candidate: f.candidate,
          executor: f.executor,
          policySha256: f.policySha256,
        }),
    /deadline/,
  )
})
test("fence rejects topology and default SHA drift across whole observation", async () => {
  const subject = await import("../recovery/fence.mjs")
  for (const name of ["listRepositoryWorkflowsComplete", "getRef"]) {
    const f = await runtimeFixture(),
      original = f.github[name]
    let calls = 0
    f.github[name] = async (...args) => {
      const result = await original(...args)
      if (++calls === 2) {
        if (name === "getRef") result.value.object.sha = "f".repeat(40)
        else result.value[0].state = "disabled_manually"
      }
      return result
    }
    await assert.rejects(() =>
      subject
        .createRecoveryFenceReader({
          github: f.github,
          git: f.git,
          now: () => 1000,
        })
        .observeLegacyFence({
          candidate: f.candidate,
          executor: f.executor,
          policySha256: f.policySha256,
        }),
    )
  }
})

test("contract requires the complete supported probe and projector import closure", async () => {
  const subject = await import("../recovery/fence.mjs"),
    f = await runtimeFixture()
  assert.ok(
    subject.RECOVERY_FENCE_PROBE_INPUTS.includes("scripts/release/recovery/fence-evidence.mjs"),
  )
  const { readFile } = await import("node:fs/promises"),
    path = await import("node:path")
  const pending = [
      "scripts/release/test/recovery-github.integration.mjs",
      "scripts/release/recovery/fence-evidence.mjs",
    ],
    seen = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, "utf8")
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/gu))
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])))
  }
  assert.deepEqual(subject.RECOVERY_FENCE_PROBE_INPUTS, [...seen].sort())
  f.contract.probeClosure = f.contract.probeClosure.slice(0, 1)
  assert.throws(() => subject.parseRecoveryFenceContract(canonical(f.contract)))
})
for (const [name, damage] of Object.entries({
  "nonwriter without current binding": (c) => {
    c.topology.find((e) => e.disposition === "nonwriter").sources = []
  },
  "mandatory release unfenced": (c) => {
    c.topology.find((e) => e.workflow.endsWith("/release.yml")).disposition = "nonwriter"
  },
  "owner source manifest": (c) => {
    c.topology.find((e) => e.disposition === "recovery-owner").sources = [
      c.topology.find((e) => e.disposition === "fenced-legacy").sources[0],
    ]
  },
  "candidate source absent": (c) => {
    c.topology.find((e) => e.disposition === "fenced-legacy").sources = c.topology
      .find((e) => e.disposition === "fenced-legacy")
      .sources.slice(1)
  },
  "pin ledger cycle": (c) => {
    c.topology.find((e) => e.disposition === "fenced-legacy").sources[0].executionInputs = [
      {
        path: "scripts/release/test/fixtures/release-script-hashes.json",
        sha256: "a".repeat(64),
      },
    ]
  },
  "duplicate workflow ID": (c) => {
    c.topology[1].workflowId = c.topology[0].workflowId
  },
  "unbounded workflows": (c) => {
    c.topology = Array(65).fill(c.topology[0])
  },
}))
  test(`reviewed contract rejects ${name}`, async () => {
    const subject = await import("../recovery/fence.mjs"),
      f = await runtimeFixture()
    damage(f.contract)
    assert.throws(() => subject.parseRecoveryFenceContract(canonical(f.contract)))
  })

test("fence retries settled service failures without renewing its observation timestamp", async () => {
  const subject = await import("../recovery/fence.mjs"),
    f = await runtimeFixture()
  let clock = 1000,
    calls = 0
  const original = f.github.getRepository,
    sleeps = []
  f.github.getRepository = async (...args) =>
    ++calls === 1
      ? { status: "AMBIGUOUS", httpStatus: 503, code: "SERVER_ERROR" }
      : original(...args)
  const reader = subject.createRecoveryFenceReader({
    github: f.github,
    git: f.git,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })
  const result = await reader.observeLegacyFence({
    candidate: f.candidate,
    executor: f.executor,
    policySha256: f.policySha256,
  })
  assert.equal(result.observedAt, 1000)
  assert.equal(result.expiresAt, 31000)
  assert.deepEqual(sleeps, [1000])
  assert.equal(calls, 3)
})

for (const [field, value] of [
  ["head_sha", "a".repeat(40)],
  ["head_branch", "fence-historical"],
  ["event", "push"],
])
  test(`positive inventory must bind correlated run ${field}`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture(),
      c = f.evidence.cases[0]
    const run = f.evidence.calls.find((call) => call.id === c.runAfterCall).response
    const inventory = f.evidence.calls.find((call) => call.id === c.afterInventoryCalls[0]).response
      .workflow_runs
    inventory.find((item) => item.id === run.id)[field] = value
    assert.throws(
      () =>
        subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: f.evidence.probeClosureSha256,
        }),
      /positive control inventory/,
    )
  })
for (const name of ["historical seed", "positive dispatch", "positive rerun"])
  test(`writer execution cannot predate ${name} request`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture()
    const reference =
      name === "historical seed"
        ? f.evidence.setup.historicalSeedJobsCall
        : f.evidence.cases[name === "positive dispatch" ? 0 : 1].jobsAfterCall
    const step = f.evidence.calls.find((call) => call.id === reference).response.jobs[0].steps[0]
    step.started_at = "2020-01-01T00:00:00.000Z"
    step.completed_at = step.started_at
    assert.throws(
      () =>
        subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: f.evidence.probeClosureSha256,
        }),
      /writer step execution/,
    )
  })
test("positive rerun cannot reassign a numeric job ID from its previous attempt", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture(),
    c = f.evidence.cases[1]
  const target = f.evidence.calls.find((call) => call.id === c.targetJobsCall).response.jobs[0]
  f.evidence.calls.find((call) => call.id === c.jobsAfterCall).response.jobs[0].id = target.id
  assert.throws(
    () =>
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    /job ID.*run\/attempt/,
  )
})

test("writer execution may start during its request and inventory may retain distinct API metadata", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const controls = [
    {
      requestCall: f.evidence.setup.historicalSeedDispatchCall,
      jobsAfterCall: f.evidence.setup.historicalSeedJobsCall,
    },
    ...f.evidence.cases.filter((c) => c.stage !== "disabled"),
  ]
  for (const control of controls) {
    const request = f.evidence.calls.find((call) => call.id === control.requestCall)
    const step = f.evidence.calls.find((call) => call.id === control.jobsAfterCall).response.jobs[0]
      .steps[0]
    step.started_at = request.startedAt
    step.completed_at = request.finishedAt
  }
  const c = f.evidence.cases[0],
    run = f.evidence.calls.find((call) => call.id === c.runAfterCall).response
  run.url = `https://api.github.com/repos/${f.evidence.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`
  const inventoryRun = f.evidence.calls
    .find((call) => call.id === c.afterInventoryCalls[0])
    .response.workflow_runs.find((item) => item.id === run.id)
  inventoryRun.url = `https://api.github.com/repos/${f.evidence.repository}/actions/runs/${run.id}`
  inventoryRun.node_id = "WFR_opaque"
  assert.equal(
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    }).cases.length,
    36,
  )
})
test("positive dispatch cannot reassign a numeric job ID from the historical seed", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const seed = f.evidence.calls.find((call) => call.id === f.evidence.setup.historicalSeedJobsCall)
    .response.jobs[0]
  f.evidence.calls.find(
    (call) => call.id === f.evidence.cases[0].jobsAfterCall,
  ).response.jobs[0].id = seed.id
  assert.throws(
    () =>
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    /job ID.*run\/attempt/,
  )
})

for (const control of ["historical seed", "current dispatch", "positive rerun"])
  test(`second-precision writer start can overlap ${control} request`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture()
    const references =
      control === "historical seed"
        ? {
            requestCall: f.evidence.setup.historicalSeedDispatchCall,
            jobsAfterCall: f.evidence.setup.historicalSeedJobsCall,
          }
        : f.evidence.cases[control === "current dispatch" ? 0 : 1]
    const request = f.evidence.calls.find((call) => call.id === references.requestCall)
    const step = f.evidence.calls.find((call) => call.id === references.jobsAfterCall).response
      .jobs[0].steps[0]
    assert.notEqual(Date.parse(request.startedAt) % 1000, 0)
    step.started_at = new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z")
    assert.equal(
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }).cases.length,
      36,
    )
  })
for (const precision of ["previous second", "one millisecond before"])
  test(`writer start interval excludes request for ${precision}`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture(),
      c = f.evidence.cases[0]
    const request = f.evidence.calls.find((call) => call.id === c.requestCall)
    const step = f.evidence.calls.find((call) => call.id === c.jobsAfterCall).response.jobs[0]
      .steps[0]
    step.started_at =
      precision === "previous second"
        ? new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000 - 1000)
            .toISOString()
            .replace(".000Z", "Z")
        : new Date(Date.parse(request.startedAt) - 1).toISOString()
    assert.throws(
      () =>
        subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: f.evidence.probeClosureSha256,
        }),
      /writer step execution/,
    )
  })

test("a previous second ending exactly at request start cannot prove execution", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture(),
    c = f.evidence.cases[0]
  const request = f.evidence.calls.find((call) => call.id === c.requestCall)
  const offset = 1000 - (Date.parse(request.startedAt) % 1000)
  const shifted = (value) => new Date(Date.parse(value) + offset).toISOString()
  f.evidence.startedAt = shifted(f.evidence.startedAt)
  f.evidence.finishedAt = shifted(f.evidence.finishedAt)
  for (const call of f.evidence.calls) {
    call.startedAt = shifted(call.startedAt)
    call.finishedAt = shifted(call.finishedAt)
    for (const job of call.response?.jobs ?? [])
      for (const step of job.steps ?? []) {
        step.started_at = shifted(step.started_at)
        step.completed_at = shifted(step.completed_at)
      }
  }
  assert.equal(Date.parse(request.startedAt) % 1000, 0)
  const step = f.evidence.calls.find((call) => call.id === c.jobsAfterCall).response.jobs[0]
    .steps[0]
  step.started_at = new Date(Date.parse(request.startedAt) - 1000)
    .toISOString()
    .replace(".000Z", "Z")
  assert.throws(
    () =>
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    /writer step execution/,
  )
})

for (const control of ["historical seed", "current dispatch", "positive rerun"])
  test(`writer completion wholly before ${control} request cannot prove execution`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture()
    const references =
      control === "historical seed"
        ? {
            requestCall: f.evidence.setup.historicalSeedDispatchCall,
            jobsAfterCall: f.evidence.setup.historicalSeedJobsCall,
          }
        : f.evidence.cases[control === "current dispatch" ? 0 : 1]
    const request = f.evidence.calls.find((call) => call.id === references.requestCall)
    const step = f.evidence.calls.find((call) => call.id === references.jobsAfterCall).response
      .jobs[0].steps[0]
    assert.ok(Date.parse(request.startedAt) % 1000 >= 2)
    step.started_at = new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z")
    step.completed_at = new Date(Date.parse(request.startedAt) - 2).toISOString()
    assert.throws(
      () =>
        subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: f.evidence.probeClosureSha256,
        }),
      /writer step execution/,
    )
  })
test("writer completion interval ending exactly at request start cannot prove execution", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const request = f.evidence.calls.find(
    (call) => call.id === f.evidence.setup.historicalSeedDispatchCall,
  )
  const step = f.evidence.calls.find((call) => call.id === f.evidence.setup.historicalSeedJobsCall)
    .response.jobs[0].steps[0]
  step.started_at = new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z")
  step.completed_at = new Date(Date.parse(request.startedAt) - 1).toISOString()
  assert.throws(
    () =>
      subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    /writer step execution/,
  )
})
test("writer completion at request start remains valid with second-precision start", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const controls = [
    {
      requestCall: f.evidence.setup.historicalSeedDispatchCall,
      jobsAfterCall: f.evidence.setup.historicalSeedJobsCall,
    },
    ...f.evidence.cases.filter((c) => c.stage !== "disabled"),
  ]
  for (const control of controls) {
    const request = f.evidence.calls.find((call) => call.id === control.requestCall)
    const step = f.evidence.calls.find((call) => call.id === control.jobsAfterCall).response.jobs[0]
      .steps[0]
    step.started_at = new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z")
    step.completed_at = request.startedAt
  }
  assert.equal(
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    }).cases.length,
    36,
  )
})

test("writer execution can order exact start and second-precision completion", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const controls = [
    {
      requestCall: f.evidence.setup.historicalSeedDispatchCall,
      jobsAfterCall: f.evidence.setup.historicalSeedJobsCall,
    },
    ...f.evidence.cases.filter((c) => c.stage !== "disabled"),
  ]
  for (const control of controls) {
    const request = f.evidence.calls.find((call) => call.id === control.requestCall)
    const step = f.evidence.calls.find((call) => call.id === control.jobsAfterCall).response.jobs[0]
      .steps[0]
    step.started_at = request.startedAt
    step.completed_at = new Date(Math.floor(Date.parse(request.startedAt) / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z")
  }
  assert.equal(
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    }).cases.length,
    36,
  )
})
for (const timing of ["definitely reversed", "after observation"])
  test(`writer execution has no feasible interval when ${timing}`, async () => {
    const subject = await import("../recovery/fence-evidence.mjs")
    const f = await fenceEvidenceFixture(),
      c = f.evidence.cases[0]
    const request = f.evidence.calls.find((call) => call.id === c.requestCall)
    const observation = f.evidence.calls.find((call) => call.id === c.jobsAfterCall)
    const step = observation.response.jobs[0].steps[0]
    step.started_at = timing === "definitely reversed" ? request.finishedAt : request.startedAt
    step.completed_at =
      timing === "definitely reversed"
        ? request.startedAt
        : new Date(Date.parse(observation.finishedAt) + 1).toISOString()
    assert.throws(
      () =>
        subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: f.evidence.probeClosureSha256,
        }),
      /writer step execution/,
    )
  })

test("fence evidence accepts empty object rerun acknowledgements only with independently observed attempts", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  for (const call of f.evidence.calls) {
    if (call.method === "POST" && call.status === 201) call.response = {}
  }
  const validate = () =>
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    })
  assert.equal(validate().cases.length, 36)
  const call = f.evidence.calls.find((c) => c.method === "POST" && c.status === 201)
  for (const response of [[], "", false, { workflow_run_id: 101 }]) {
    call.response = response
    assert.throws(validate, /rerun must advance/)
  }
})

test("fence projection bounds each raw response and removes only unconsumed API metadata", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const { calls, ...witness } = f.evidence
  for (const c of calls) {
    if (c.response && typeof c.response === "object" && !Array.isArray(c.response))
      c.response.serviceMetadata = Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [`ignored${i}`, i]),
      )
  }
  const project = () =>
    subject.projectRecoveryFenceEvidence(calls, witness, {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: witness.probeClosureSha256,
    })
  const result = project()
  assert.equal(result.cases.length, 36)
  assert.ok(
    result.calls
      .filter((c) => c.method === "GET" && c.status === 200)
      .every((c) => !c.response || !Object.hasOwn(c.response, "serviceMetadata")),
  )
  assert.ok(calls[0].response.serviceMetadata)
  const observed = calls.find((c) => c.id === witness.cases[0].runAfterCall)
  observed.response.head_sha = "c".repeat(40)
  assert.throws(project, /fixture job identity mismatch|executed source mismatch/)
})

test("fence raw projection rejects proxied ledgers without invoking traps", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const { calls, ...witness } = f.evidence
  let traps = 0
  const handler = Object.fromEntries(
    ["get", "getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"].map((name) => [
      name,
      (...args) => {
        traps++
        return Reflect[name](...args)
      },
    ]),
  )
  assert.throws(
    () =>
      subject.projectRecoveryFenceEvidence(new Proxy(calls, handler), witness, {
        fixtureBytes: f.fixtureBytes,
        probeClosureSha256: f.evidence.probeClosureSha256,
      }),
    /bounded raw ledger/,
  )
  assert.equal(traps, 0, "ledger inspection must not execute caller code")
})

test("fence raw projection rejects accessor array entries without invoking them", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const { calls, ...witness } = f.evidence
  let invoked = false
  Object.defineProperty(calls, "0", {
    get() {
      invoked = true
      return {}
    },
    enumerable: true,
  })
  assert.throws(() =>
    subject.projectRecoveryFenceEvidence(calls, witness, {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: witness.probeClosureSha256,
    }),
  )
  assert.equal(invoked, false)
})

test("fence setup accepts a branch read followed by the exact historical content read before dispatch", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  const f = await fenceEvidenceFixture()
  const contentIndex = f.evidence.calls.findIndex(
    (c) => c.id === f.evidence.setup.historicalFixtureCall,
  )
  const branchIndex = f.evidence.calls.findIndex((c) => c.id === f.evidence.setup.initialBranchCall)
  const content = f.evidence.calls[contentIndex],
    branch = f.evidence.calls[branchIndex]
  const interval = {
    startedAt: content.startedAt,
    finishedAt: content.finishedAt,
  }
  Object.assign(content, {
    startedAt: branch.startedAt,
    finishedAt: branch.finishedAt,
  })
  Object.assign(branch, interval)
  f.evidence.calls[contentIndex] = branch
  f.evidence.calls[branchIndex] = content
  assert.equal(
    subject.validateRecoveryFenceEvidence(canonical(f.evidence), {
      fixtureBytes: f.fixtureBytes,
      probeClosureSha256: f.evidence.probeClosureSha256,
    }).cases.length,
    36,
  )
})

test("fence raw projection rejects oversized ledgers, sparse arrays and symbol properties", async () => {
  const subject = await import("../recovery/fence-evidence.mjs")
  for (const damage of ["oversized", "sparse", "symbol"]) {
    const f = await fenceEvidenceFixture()
    const { calls, ...witness } = f.evidence
    if (damage === "oversized") {
      const padding = "x".repeat(Math.ceil((33 * 1024 * 1024) / calls.length))
      for (const c of calls) c.padding = padding
    }
    if (damage === "sparse") delete calls[0]
    if (damage === "symbol") calls[Symbol("hidden")] = {}
    assert.throws(
      () =>
        subject.projectRecoveryFenceEvidence(calls, witness, {
          fixtureBytes: f.fixtureBytes,
          probeClosureSha256: witness.probeClosureSha256,
        }),
      /raw ledger byte bound|dense raw call array/,
    )
  }
})

async function platformFixture(damage = () => {}) {
  const { digest } = await import("./support/recovery-fence-fixture.mjs")
  const f = await runtimeFixture()
  f.tree = [
    {
      path: "AGENTS.md",
      mode: "100644",
      sha256: digest("reviewed instructions\n"),
    },
  ]
  f.put(f.defaultSha, "AGENTS.md", "reviewed instructions\n")
  f.reviews = []
  for (const [workflowId, service, workflow] of [
    ["6", "copilot-pull-request-reviewer", "dynamic/agents/copilot-pull-request-reviewer"],
    ["7", "dependabot-updates", "dynamic/dependabot/dependabot-updates"],
  ]) {
    const entry = {
      workflowId,
      workflow,
      disposition: "platform-nonwriter",
      service,
      reviewSha256: "",
    }
    const review = {
      schemaVersion: 1,
      kind: "recovery-platform-nonwriter-review",
      repository: f.candidate.repository,
      repositoryId: f.candidate.repositoryId,
      candidateSourceSha: f.sourceSha,
      workflowId,
      workflow,
      service,
      observedAt: 900,
      expiresAt: 86400900,
      rationale: "Fixture semantic review: service cannot mutate candidate release or evidence.",
      observations: ["Fixture repository settings and permissions inspected."],
      operationalAssumptions: [
        "Settings and platform authority remain as observed; unknown authority blocks admission.",
      ],
      historicalRerunReasoning:
        "Fixture review covers historical reruns and their original authority.",
      headControlledInputReasoning:
        "Fixture review covers untrusted PR inputs and configuration execution.",
      configuration: structuredClone(f.tree),
    }
    f.contract.topology.push(entry)
    f.values.listRepositoryWorkflowsComplete.push({
      id: Number(workflowId),
      path: workflow,
      state: "active",
    })
    f.reviews.push({ entry, review })
  }
  f.git.listTreeEntries = async ({ ref }) => {
    assert.equal(ref, f.defaultSha)
    return f.tree.map((e) => `${e.mode} blob ${"b".repeat(40)}\t${e.path}\0`).join("")
  }
  await damage(f)
  for (const { entry, review } of f.reviews) {
    const raw = canonical(review)
    entry.reviewSha256 = digest(raw)
    f.put(
      f.controllerSha,
      `scripts/release/recovery-platform-reviews/${entry.reviewSha256}.json`,
      raw,
    )
  }
  f.contract.topology.sort((a, b) => (a.workflow < b.workflow ? -1 : 1))
  f.contractSha256 = digest(canonical(f.contract))
  f.put(
    f.controllerSha,
    `scripts/release/recovery-fence-contracts/${f.contractSha256}.json`,
    canonical(f.contract),
  )
  f.policy.fence.contracts = [f.contractSha256]
  f.policySha256 = digest(canonical(f.policy))
  f.put(f.controllerSha, "scripts/release/recovery/policy.json", canonical(f.policy))
  return f
}
async function observePlatform(f, now = () => 1000) {
  const { createRecoveryFenceReader } = await import("../recovery/fence.mjs")
  return createRecoveryFenceReader({
    github: f.github,
    git: f.git,
    now,
  }).observeLegacyFence({
    candidate: f.candidate,
    executor: f.executor,
    policySha256: f.policySha256,
  })
}
test("two reviewed platform services preserve complete topology and legacy drain", async () => {
  const f = await platformFixture()
  const result = await observePlatform(f)
  assert.equal(result.writers.length, 4)
  assert.equal(f.calls.filter((c) => c[0] === "listRepositoryWorkflowsComplete").length, 2)
  assert.equal(f.calls.filter((c) => c[0] === "listWorkflowRunsAllShasComplete").length, 4)
  for (const { entry } of f.reviews)
    assert.ok(
      f.calls.some(
        ([name, ref, path]) =>
          name === "showFile" &&
          ref === f.controllerSha &&
          path.endsWith(`${entry.reviewSha256}.json`),
      ),
    )
})
for (const [name, damage] of Object.entries({
  "wrong repository": (f) => {
    f.reviews[0].review.repository = "other/repo"
  },
  "wrong repository ID": (f) => {
    f.reviews[0].review.repositoryId = "9"
  },
  "wrong candidate": (f) => {
    f.reviews[0].review.candidateSourceSha = "9".repeat(40)
  },
  "wrong workflow ID": (f) => {
    f.reviews[0].review.workflowId = "9"
  },
  "wrong workflow path": (f) => {
    f.reviews[0].review.workflow = "dynamic/other"
  },
  "wrong service": (f) => {
    f.reviews[0].review.service = "dependabot-updates"
  },
  "unknown service": (f) => {
    f.reviews[0].entry.service = "other"
  },
  "platform sources": (f) => {
    f.reviews[0].entry.sources = []
  },
  "future review": (f) => {
    f.reviews[0].review.observedAt = 1001
  },
  "expired review": (f) => {
    f.reviews[0].review.expiresAt = 1000
  },
  "long review window": (f) => {
    f.reviews[0].review.expiresAt++
  },
  "malformed timestamp": (f) => {
    f.reviews[0].review.observedAt = "900"
  },
  "missing rationale": (f) => {
    delete f.reviews[0].review.rationale
  },
  "missing observations": (f) => {
    f.reviews[0].review.observations = []
  },
  "missing assumptions": (f) => {
    f.reviews[0].review.operationalAssumptions = []
  },
  "missing historical reasoning": (f) => {
    f.reviews[0].review.historicalRerunReasoning = ""
  },
  "missing head reasoning": (f) => {
    f.reviews[0].review.headControlledInputReasoning = ""
  },
  "review-selected scope": (f) => {
    f.reviews[0].review.selector = ["AGENTS.md"]
  },
  "removed configuration": (f) => {
    f.tree = []
  },
  "changed configuration": (f) => {
    f.put(f.defaultSha, "AGENTS.md", "changed")
  },
  "changed mode": (f) => {
    f.tree[0].mode = "100755"
  },
  symlink: (f) => {
    f.tree[0].mode = "120000"
    f.reviews.forEach(({ review }) => {
      review.configuration[0].mode = "120000"
    })
  },
  "missing tree capability": (f) => {
    delete f.git.listTreeEntries
  },
  "unavailable tree": (f) => {
    f.git.listTreeEntries = async () => {
      throw new Error("unavailable")
    }
  },
  "incomplete tree": (f) => {
    f.git.listTreeEntries = async () => `100644 blob ${"b".repeat(40)}\tAGENTS.md`
  },
  "replaced identity": (f) => {
    f.values.listRepositoryWorkflowsComplete.find((w) => w.id === 6).id = 99
  },
}))
  test(`platform review blocks ${name}`, async () => {
    await assert.rejects(() => platformFixture(damage).then((f) => observePlatform(f)))
  })
for (const path of [
  ".github/dependabot.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/copilot-instructions.md",
  ".github/instructions/review.instructions.md",
  ".github/skills/review/SKILL.md",
  ".vscode/mcp.json",
  ".mcp.json",
  "src/AGENTS.md",
  ".agents/skills/review/SKILL.md",
  ".claude/skills/review/scripts/review.sh",
])
  test(`platform review detects newly added ${path}`, async () => {
    const f = await platformFixture((f) => {
      f.tree.push({ path, mode: "100644" })
    })
    await assert.rejects(() => observePlatform(f), /configuration/)
  })
for (const damage of ["missing", "tampered"])
  test(`platform review rejects ${damage} controller record`, async () => {
    const f = await platformFixture()
    const path = `${f.controllerSha}:scripts/release/recovery-platform-reviews/${f.reviews[0].entry.reviewSha256}.json`
    if (damage === "missing") f.files.delete(path)
    else f.files.set(path, `${f.files.get(path)} `)
    await assert.rejects(() => observePlatform(f))
  })
test("platform review may bind absence only through a complete empty relevant tree", async () => {
  const f = await platformFixture((f) => {
    f.tree = []
    for (const { review } of f.reviews) review.configuration = []
  })
  assert.equal((await observePlatform(f)).inventoryComplete, true)
})

test("platform proof cannot outlive its semantic review", async () => {
  const f = await platformFixture((f) => {
    f.reviews[0].review.expiresAt = 2000
  })
  assert.equal((await observePlatform(f)).expiresAt, 2000)
})
test("platform review must remain fresh through final inventory", async () => {
  const f = await platformFixture((f) => {
    f.reviews[0].review.expiresAt = 2000
  })
  const original = f.github.listRepositoryWorkflowsComplete
  let clock = 1000,
    calls = 0
  f.github.listRepositoryWorkflowsComplete = async (...args) => {
    if (++calls === 2) clock = 2000
    return original(...args)
  }
  await assert.rejects(() => observePlatform(f, () => clock), /observation window/)
})
for (const raw of [
  undefined,
  "malformed\0",
  `160000 commit ${"b".repeat(40)}\tsubmodule\0`,
  `100644 blob ${"b".repeat(40)}\tAGENTS.md\0`.repeat(2),
])
  test(`platform review rejects malformed or unsupported complete tree ${String(raw).slice(0, 25)}`, async () => {
    const f = await platformFixture((f) => {
      f.git.listTreeEntries = async () => raw
    })
    await assert.rejects(() => observePlatform(f), /configuration tree/)
  })

test("platform review binds bytes of reviewed Claude skill supporting resources", async () => {
  const { digest } = await import("./support/recovery-fence-fixture.mjs")
  const path = ".claude/skills/review/scripts/review.sh"
  const f = await platformFixture((f) => {
    f.tree.unshift({
      path,
      mode: "100755",
      sha256: digest("reviewed script\n"),
    })
    f.put(f.defaultSha, path, "reviewed script\n")
    for (const { review } of f.reviews) review.configuration = structuredClone(f.tree)
  })
  assert.equal((await observePlatform(f)).inventoryComplete, true)
  f.put(f.defaultSha, path, "modified script\n")
  await assert.rejects(() => observePlatform(f), /input bytes changed/)
})

async function historicalAuxiliaryFixture(damage = () => {}) {
  const { digest } = await import("./support/recovery-fence-fixture.mjs")
  const f = await runtimeFixture()
  f.auxiliary = {
    workflowId: "8",
    workflow: ".github/workflows/probe-draft-visibility.yml",
    disposition: "fenced-legacy",
    sources: [
      {
        source: { kind: "commit", sha: "c".repeat(40) },
        workflowSha256: digest("historical diagnostic\n"),
        executionInputs: [],
      },
    ],
  }
  f.put("c".repeat(40), f.auxiliary.workflow, "historical diagnostic\n")
  f.contract.topology.push(f.auxiliary)
  f.values.listRepositoryWorkflowsComplete.push({
    id: 8,
    path: f.auxiliary.workflow,
    state: "disabled_manually",
  })
  await damage(f)
  f.contract.topology.sort((a, b) => (a.workflow < b.workflow ? -1 : 1))
  f.contractSha256 = digest(canonical(f.contract))
  f.put(
    f.controllerSha,
    `scripts/release/recovery-fence-contracts/${f.contractSha256}.json`,
    canonical(f.contract),
  )
  f.policy.fence.contracts = [f.contractSha256]
  f.policySha256 = digest(canonical(f.policy))
  f.put(f.controllerSha, "scripts/release/recovery/policy.json", canonical(f.policy))
  return f
}
test("historical-only auxiliary writer is fenced by exact disabled identity and all-SHA drainage", async () => {
  const f = await historicalAuxiliaryFixture()
  const result = await observePlatform(f)
  assert.equal(result.writers.length, 5)
  assert.ok(
    result.writers.some(
      (w) => w.workflow === f.auxiliary.workflow && w.sourceSha === "c".repeat(40),
    ),
  )
  assert.equal(f.calls.filter(([name, id]) => name === "getWorkflowById" && id === "8").length, 2)
  assert.equal(
    f.calls.filter(
      ([name, args]) => name === "listWorkflowRunsAllShasComplete" && args.workflowId === "8",
    ).length,
    2,
  )
})
for (const [name, damage] of Object.entries({
  "active historical-only writer": (f) => {
    f.values.listRepositoryWorkflowsComplete.find((w) => w.id === 8).state = "active"
  },
  "nonterminal run at another SHA": (f) => {
    const original = f.github.listWorkflowRunsAllShasComplete
    f.github.listWorkflowRunsAllShasComplete = async (args) =>
      args.workflowId === "8"
        ? {
            status: "PRESENT",
            value: [
              {
                id: 88,
                run_attempt: 1,
                head_sha: "f".repeat(40),
                status: "queued",
                conclusion: null,
              },
            ],
          }
        : original(args)
  },
  "missing historical binding": (f) => {
    f.auxiliary.sources = []
  },
  "only current-default binding": (f) => {
    f.auxiliary.sources[0].source = { kind: "current-default" }
    f.put(f.defaultSha, f.auxiliary.workflow, "historical diagnostic\n")
  },
  "unavailable historical bytes": (f) => {
    f.files.delete(`${"c".repeat(40)}:${f.auxiliary.workflow}`)
  },
  "changed historical bytes": (f) => {
    f.put("c".repeat(40), f.auxiliary.workflow, "changed")
  },
  "changed historical input": (f) => {
    f.auxiliary.sources[0].executionInputs = [
      { path: "scripts/historical-diagnostic.mjs", sha256: "0".repeat(64) },
    ]
    f.put("c".repeat(40), "scripts/historical-diagnostic.mjs", "changed")
  },
}))
  test(`auxiliary writer fence rejects ${name}`, async () => {
    const f = await historicalAuxiliaryFixture(damage)
    await assert.rejects(() => observePlatform(f))
  })
for (const workflow of [
  ".github/workflows/release.yml",
  ".github/workflows/published-artifact-verify.yml",
])
  test(`mandatory ${workflow} still requires candidate source binding`, async () => {
    const f = await historicalAuxiliaryFixture((f) => {
      f.contract.topology.find((w) => w.workflow === workflow).sources[0].source.sha = "c".repeat(
        40,
      )
      f.put("c".repeat(40), workflow, `name: ${workflow}\n`)
    })
    await assert.rejects(() => observePlatform(f), /candidate source binding/)
  })

test("fence overlaps independent writers while preserving each double-observation sequence", async () => {
  const { createRecoveryFenceReader } = await import("../recovery/fence.mjs")
  const f = await runtimeFixture()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let first
  const started = new Promise((resolve) => {
    first = resolve
  })
  const entered = new Set(),
    sequences = new Map()
  const state = f.github.getWorkflowById,
    runs = f.github.listWorkflowRunsAllShasComplete
  f.github.getWorkflowById = async (args) => {
    const sequence = sequences.get(args.workflowId) ?? []
    sequences.set(args.workflowId, sequence)
    sequence.push("state")
    if (!entered.has(args.workflowId)) {
      entered.add(args.workflowId)
      first()
      await gate
    }
    return state(args)
  }
  f.github.listWorkflowRunsAllShasComplete = async (args) => {
    sequences.get(args.workflowId).push("runs")
    return runs(args)
  }
  const pending = createRecoveryFenceReader({
    github: f.github,
    git: f.git,
  }).observeLegacyFence({
    candidate: f.candidate,
    executor: f.executor,
    policySha256: f.policySha256,
  })
  try {
    await started
    await new Promise(setImmediate)
    assert.equal(entered.size, 2, "one blocked writer must not serialize an independent writer")
  } finally {
    release()
    await pending
  }
  for (const sequence of sequences.values())
    assert.deepEqual(sequence, ["state", "runs", "state", "runs"])
})

test("fence limits concurrent workflow observations to four", async () => {
  const { digest } = await import("./support/recovery-fence-fixture.mjs")
  const f = await historicalAuxiliaryFixture((f) => {
    for (let id = 10; id < 15; id++) {
      const workflow = `.github/workflows/auxiliary-${id}.yml`
      f.contract.topology.push({
        ...structuredClone(f.auxiliary),
        workflowId: String(id),
        workflow,
      })
      f.put("c".repeat(40), workflow, "historical diagnostic\n")
      f.values.listRepositoryWorkflowsComplete.push({
        id,
        path: workflow,
        state: "disabled_manually",
      })
    }
  })
  assert.equal(digest(canonical(f.contract)), f.contractSha256)
  let release, first
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    first = resolve
  })
  const entered = new Set()
  const original = f.github.getWorkflowById
  let active = 0,
    maximum = 0
  f.github.getWorkflowById = async (args) => {
    if (!entered.has(args.workflowId)) {
      entered.add(args.workflowId)
      maximum = Math.max(maximum, ++active)
      first()
      try {
        await gate
      } finally {
        active--
      }
    }
    return original(args)
  }
  const pending = observePlatform(f)
  try {
    await started
    await new Promise(setImmediate)
    assert.equal(entered.size, 4)
  } finally {
    release()
    await pending
  }
  assert.equal(maximum, 4)
  assert.equal(entered.size, 8)
})

test("failed fence joins already-started independent observations before rejecting", async () => {
  const f = await runtimeFixture()
  let release, second
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const secondStarted = new Promise((resolve) => {
    second = resolve
  })
  const original = f.github.getWorkflowById
  f.github.getWorkflowById = async (args) => {
    if (args.workflowId === "1") {
      await secondStarted
      throw new Error("intentional writer read failure")
    }
    second()
    await gate
    return original(args)
  }
  let settled = false
  const pending = observePlatform(f)
  const observed = pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  try {
    await secondStarted
    await new Promise(setImmediate)
    assert.equal(settled, false, "failing observation must wait for started sibling reads")
  } finally {
    release()
    await observed
  }
  await assert.rejects(pending, /intentional writer read failure/)
})

test("fence admission rejects an executor closure different from reviewed source", async () => {
  const { createRecoveryFenceReader } = await import("../recovery/fence.mjs")
  const f = await runtimeFixture()
  await assert.rejects(() =>
    createRecoveryFenceReader({
      github: f.github,
      git: f.git,
      now: () => 1000,
    }).observeLegacyFence({
      candidate: f.candidate,
      executor: { ...f.executor, verifierClosureSha256: "0".repeat(64) },
      policySha256: f.policySha256,
    }),
  )
})

test("fence selects exactly the repaired contract with fresh replacement source bindings", async () => {
  const { createRecoveryFenceReader } = await import("../recovery/fence.mjs")
  const { hashVerifierClosure } = await import("../recovery/policy.mjs")
  const { digest } = await import("./support/recovery-fence-fixture.mjs")
  const f = await runtimeFixture()
  const baseline = "b".repeat(40)
  const changed = "scripts/release/smoke/runtime-targets.mjs"
  const originalBytes = f.files.get(`${f.controllerSha}:${changed}`)
  f.contract.topology.find(
    (entry) => entry.workflow === ".github/workflows/ci.yml",
  ).sources[0].executionInputs = [{ path: changed, sha256: digest(originalBytes) }]
  const originalDigest = digest(canonical(f.contract))
  f.policy.fence.contracts = [originalDigest]
  f.put(f.controllerSha, "scripts/release/recovery/policy.json", canonical(f.policy))
  f.put(
    f.controllerSha,
    `scripts/release/recovery-fence-contracts/${originalDigest}.json`,
    canonical(f.contract),
  )
  for (const [key, value] of [...f.files])
    if (key.startsWith(`${f.controllerSha}:`))
      f.files.set(key.replace(f.controllerSha, baseline), value)
  f.put(f.controllerSha, changed, "// repaired runtime probe\n")
  f.put(f.defaultSha, changed, "// repaired runtime probe\n")
  const replacement = structuredClone(f.contract)
  replacement.topology.find(
    (entry) => entry.workflow === ".github/workflows/ci.yml",
  ).sources[0].executionInputs[0].sha256 = digest(f.files.get(`${f.controllerSha}:${changed}`))
  const replacementDigest = digest(canonical(replacement))
  f.put(
    f.controllerSha,
    `scripts/release/recovery-fence-contracts/${replacementDigest}.json`,
    canonical(replacement),
  )
  const closure = await hashVerifierClosure(
    { controllerSha: f.controllerSha, inputs: f.policy.verifierClosure.inputs },
    f.git.showFile,
  )
  f.executor.verifierClosureSha256 = closure
  f.policySha256 = digest(canonical(f.policy))
  const record = {
    schemaVersion: 1,
    kind: "recovery-verifier-repair",
    candidate: f.candidate,
    policySha256: f.policySha256,
    baselineControllerSha: baseline,
    originalClosureSha256: f.policy.verifierClosure.sha256,
    replacementClosureSha256: closure,
    inputs: f.policy.verifierClosure.inputs.map((path) => ({
      path,
      oldSha256: digest(f.files.get(`${baseline}:${path}`)),
      newSha256: digest(f.files.get(`${f.controllerSha}:${path}`)),
    })),
    originalContractSha256: originalDigest,
    replacementContractSha256: replacementDigest,
    adoption: {
      assetName: `recovery-v2-adoption-${baseline}-10-1-11.json`,
      id: "12",
      size: 1000,
      sha256: "3".repeat(64),
    },
  }
  f.put(
    f.controllerSha,
    "scripts/release/recovery-verifier-repairs/v0.8.24.json",
    canonical(record),
  )
  const result = await createRecoveryFenceReader({
    github: f.github,
    git: f.git,
    now: () => 1000,
  }).observeLegacyFence({
    candidate: f.candidate,
    executor: f.executor,
    policySha256: f.policySha256,
  })
  assert.equal(result.contractSha256, replacementDigest)
  assert.ok(result.inventoryComplete)
})
