import assert from "node:assert/strict"
import test from "node:test"
import { canonical, markerAt, wireFixtures } from "./support/recovery-fixture.mjs"

const metadata = await import("../recovery/metadata.mjs").catch(() => ({}))
const observer = await import("../recovery/observe.mjs").catch(() => ({}))

test("v2 metadata round trips canonical bounded wire without a legacy interpretation", () => {
  assert.equal(typeof metadata.renderRecoveryReleaseBody, "function")
  const marker = markerAt("PUBLICATION_READY")
  const body = metadata.renderRecoveryReleaseBody({
    marker,
    body: "Original notes",
  })
  assert.deepEqual(metadata.parseRecoveryReleaseMarker(body), marker)
  for (const corrupt of [
    body.replace('"schemaVersion":2', '"schemaVersion":3'),
    `${body}\n${body}`,
    body.replace('"revision":5', '"revision":5,"revision":5'),
  ])
    assert.throws(() => metadata.parseRecoveryReleaseMarker(corrupt))
  assert.throws(() =>
    metadata.renderRecoveryReleaseBody({
      marker,
      body: "<!-- B4_RELEASE_CONTROLLER_MARKER\n",
    }),
  )
})

test("fixed finalization reconstructs readiness metadata without recursive digests", () => {
  assert.equal(typeof metadata.renderRecoveryFinalMetadata, "function")
  const f = wireFixtures()
  const rendered = metadata.renderRecoveryFinalMetadata(f.finalization, f.finalRef)
  assert.equal(rendered.title, f.finalization.metadata.title)
  assert.deepEqual(
    metadata.parseRecoveryReleaseMarker(rendered.body),
    markerAt("PUBLICATION_READY", f),
  )
  assert.ok(!JSON.stringify(f.finalization).includes(f.finalRef.sha256))
})

test("independent recovery observer is exported separately from the v1 observation schema", () => {
  assert.equal(typeof observer.observeRecoveryCandidate, "function")
})

import { recoveryRemote } from "./support/recovery-observe-fixture.mjs"

const observe = async (args) => {
  assert.equal(typeof observer.observeRecoveryCandidate, "function")
  return observer.observeRecoveryCandidate(args)
}

test("reserved legacy NPM_COMPLETE independently checks unchanged original assets and all npm versions", async () => {
  const remote = await recoveryRemote()
  const result = await observe(remote.args)
  assert.equal(result.outcome, "recovery-required")
  assert.equal(result.phase, "NPM_COMPLETE")
  assert.equal(result.terminal, false)
  assert.equal(result.facts.manifestPackages.length, remote.base.manifest.packages.length)
  assert.equal(result.facts.npmEvidence.conclusion, "success")
  assert.ok(remote.calls.includes("dispose"))
})

test("adopted draft uses separate recovery facts without a fake v1 smoke or publication proof", async () => {
  const remote = await recoveryRemote()
  remote.release.body = metadata.renderRecoveryReleaseBody({
    marker: remote.marker,
    body: "Notes",
  })
  remote.setAssets([...remote.baseAssets, remote.adoption.archive, remote.adoptionRef])
  const result = await observe(remote.args)
  assert.equal(result.phase, "RECOVERY_ADOPTED")
  assert.equal(result.outcome, "recovery-required")
  assert.equal(result.terminal, false)
  assert.equal(result.observation, undefined)
})

for (const body of ["corrupt <!-- B4_RELEASE_CONTROLLER_MARKER\n{", "", "Human edited notes"]) {
  test(`published immutable finalization remains terminal despite display body ${JSON.stringify(body)}`, async () => {
    const remote = await recoveryRemote({ published: true })
    remote.release.body = body
    remote.release.name = "Human edited title"
    const result = await observe(remote.args)
    assert.equal(result.outcome, "complete", JSON.stringify(result.errors))
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.terminal, true)
    assert.equal(result.displayDrift, true)
  })
}

for (const [name, mutate] of [
  [
    "absent npm package",
    (r) => {
      r.args.npm.observePackageVersion = async () => ({
        status: "ABSENT",
        httpStatus: 404,
      })
    },
  ],
  [
    "conflicting npm tarball",
    (r) => {
      r.args.npm.downloadRegistryTarball = async () => ({
        status: "PRESENT",
        tarball: { contentBase64: "Y29uZmxpY3Q=" },
      })
    },
  ],
  [
    "wrong canonical release ID",
    (r) => {
      r.release.id = 999
    },
  ],
  [
    "wrong annotated tag",
    (r) => {
      r.args.github.getGitTag = async () => ({
        status: "PRESENT",
        value: {
          tag: r.c.tag,
          sha: r.c.tagObjectSha,
          object: { type: "commit", sha: "e".repeat(40) },
        },
      })
    },
  ],
  [
    "original asset byte replacement",
    (r) => {
      r.raws.set("manifest.json", Buffer.from("tampered"))
    },
  ],
  [
    "unknown marker schema",
    (r) => {
      r.release.body = metadata
        .renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
        .replace('"schemaVersion":2', '"schemaVersion":3')
    },
  ],
  [
    "invalid original attestation",
    (r) => {
      r.args.attestations = { verify: async () => ({ status: "INVALID" }) }
    },
  ],
  [
    "npm source mismatch",
    (r) => {
      r.args.npmAuditFactory = {
        create: async () => ({
          verifyPackage: async () => ({
            status: "verified",
            signature: { status: "valid" },
          }),
          dispose: async () => {},
        }),
      }
    },
  ],
])
  test(`${name} blocks recovery without opening legacy ownership`, async () => {
    const r = await recoveryRemote()
    mutate(r)
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.ok(result.errors.length > 0)
  })

test("terminal chain cannot fabricate reviewed-main-ci from a policy and source digest", async () => {
  const r = await recoveryRemote({ published: true })
  r.args.github.getCommitCheckRuns = async () => ({
    status: "PRESENT",
    value: [],
  })
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})

import { runRecoveryRead } from "../recovery/policy.mjs"

test("large release payload uses an explicit bounded transport budget, preserving the receipt JSON cap", async () => {
  const base64 = Buffer.alloc(12_107_594, 1).toString("base64")
  const result = await runRecoveryRead(
    { phaseDeadline: Date.now() + 10000, responseBytes: base64.length + 256 },
    async () => ({ status: "PRESENT", contentBase64: base64 }),
  )
  assert.equal(result.contentBase64, base64)
  await assert.rejects(
    runRecoveryRead({ phaseDeadline: Date.now() + 10000 }, async () => ({
      status: "PRESENT",
      contentBase64: base64,
    })),
    /byte limit/,
  )
})
for (const options of [
  { operations: ["adopt"] },
  { ownerWorkflow: ".github/workflows/unapproved.yml" },
  { ownerWorkflow: ".github/workflows/release-postpublication-audit.yml" },
  { platform: "darwin" },
])
  test(`coherent terminal chain rejects ineligible historical authority ${JSON.stringify(options)}`, async () => {
    const r = await recoveryRemote({ published: true, ...options })
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
test("unknown retained receipt cannot become valid by appearing in the final inventory", async () => {
  const r = await recoveryRemote({
    published: true,
    retainedRaw: '{"schemaVersion":99}\n',
  })
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})
for (const [phase, ref] of [
  ["VERIFICATION_COMPLETE", "setRef"],
  ["AUDIT_PENDING", "dispatchRef"],
  ["AUDIT_VERIFIED", "auditRef"],
])
  test(`${phase} collects and verifies its selected intermediate recovery evidence`, async () => {
    const r = await recoveryRemote()
    const marker = {
      ...r.marker,
      phase,
      revision: phase === "VERIFICATION_COMPLETE" ? 2 : phase === "AUDIT_PENDING" ? 3 : 4,
      verificationSet: r.setRef,
      audit: phase === "VERIFICATION_COMPLETE" ? null : r[ref],
    }
    r.release.body = metadata.renderRecoveryReleaseBody({
      marker,
      body: "notes",
    })
    r.setAssets(r.allAssets.filter((a) => a.assetName !== "recovery-v2-finalization.json"))
    const result = await observe(r.args)
    assert.equal(result.outcome, "recovery-required", JSON.stringify(result.errors))
    assert.ok(result.facts.verification)
    if (phase !== "VERIFICATION_COMPLETE") assert.ok(result.facts.audit)
  })
test("observer rejects dependency accessors before executing them", async () => {
  const r = await recoveryRemote()
  let calls = 0
  Object.defineProperty(r.args, "github", {
    get() {
      calls++
      return {}
    },
  })
  await assert.rejects(observe(r.args), /descriptor|safe|accessor/)
  assert.equal(calls, 0)
})
test("missing current recovery policy blocks durable ownership rather than dropping to legacy", async () => {
  const r = await recoveryRemote({ published: true })
  r.args.controllerRef = "f".repeat(40)
  const original = r.args.git.showFile
  r.args.git.showFile = async (args) => {
    if (args.ref === r.args.controllerRef && args.path === "scripts/release/recovery/policy.json")
      throw new Error("policy missing")
    return original(args)
  }
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})
test("timed out verifier cleanup waits for settlement and runs exactly once without accepting late proof", async () => {
  assert.equal(typeof observer.createRecoveryWorkBudget, "function")
  let timeout,
    resolveWork,
    cleanups = 0
  const budget = observer.createRecoveryWorkBudget(
    { phaseDeadline: 100 },
    {
      now: () => 0,
      setTimer: (fn) => {
        timeout = fn
        return 1
      },
      clearTimer: () => {},
    },
  )
  const delayed = new Promise((resolve) => {
    resolveWork = resolve
  })
  const result = budget.work(
    () => delayed,
    async () => {
      cleanups++
    },
  )
  await Promise.resolve()
  timeout()
  await assert.rejects(result, /deadline/)
  assert.equal(cleanups, 0)
  resolveWork({ status: "verified" })
  await delayed
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(cleanups, 1)
  assert.equal(budget.settled(), false)
  await assert.rejects(
    budget.work(async () => "late authority"),
    /not settled/,
  )
})
test("asset budgets admit separate original and retained limits and reject a namespace overflow", () => {
  assert.equal(typeof observer.normalizeRecoveryAssetInventory, "function")
  const assets = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    name: `package-${i}.tgz`,
    size: 1024 * 1024,
    digest: `sha256:${"a".repeat(64)}`,
  })).concat(
    Array.from({ length: 40 }, (_, i) => ({
      id: i + 41,
      name: `recovery-v2-retained-${i}.json`,
      size: 1024 * 1024,
      digest: `sha256:${"b".repeat(64)}`,
    })),
  )
  assert.equal(observer.normalizeRecoveryAssetInventory(assets).length, 80)
  assets.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      id: i + 81,
      name: `recovery-v2-retained-extra-${i}.json`,
      size: 1024 * 1024,
      digest: `sha256:${"b".repeat(64)}`,
    })),
  )
  assert.throws(() => observer.normalizeRecoveryAssetInventory(assets), /budget/)
})

test("idle npm verifier is disposed when an ordinary read exhausts the observation deadline", async () => {
  const r = await recoveryRemote()
  const originalNow = Date.now
  let tick = originalNow()
  let cleanupCalls = 0
  const create = r.args.npmAuditFactory.create
  r.args.npmAuditFactory.create = async () => {
    const verifier = await create()
    return {
      ...verifier,
      async dispose() {
        cleanupCalls++
        return verifier.dispose()
      },
    }
  }
  const read = r.args.npm.observePackageVersion
  r.args.npm.observePackageVersion = async (args) => {
    tick += 1_200_001
    return read(args)
  }
  Date.now = () => tick
  try {
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.equal(cleanupCalls, 1)
  } finally {
    Date.now = originalNow
  }
})

test("canonical published recovery metadata is terminal without display drift", async () => {
  const r = await recoveryRemote({ published: true })
  const rendered = metadata.renderRecoveryFinalMetadata(r.finalization, r.finalRef)
  r.release.name = rendered.title
  r.release.body = rendered.body
  const result = await observe(r.args)
  assert.equal(result.outcome, "complete", JSON.stringify(result.errors))
  assert.equal(result.terminal, true)
  assert.equal(result.facts.publication.metadata, "matching")
  assert.equal(result.displayDrift, false)
})

for (const omitArchive of [false, true])
  test(`legacy NPM_COMPLETE with fixed finalization blocks even with ${omitArchive ? "invalid" : "valid"} final inventory`, async () => {
    const r = await recoveryRemote()
    const finalization = omitArchive
      ? {
          ...r.finalization,
          assets: r.finalization.assets.filter((a) => a.assetName !== r.adoption.archive.assetName),
        }
      : r.finalization
    const finalRef = r.add("recovery-v2-finalization.json", finalization)
    r.setAssets([...r.allAssets.filter((a) => a.assetName !== finalRef.assetName), finalRef])
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.match(result.errors.join("; "), /legacy.*finalization|finalization.*legacy/)
  })

test("observer supplies canonical independently downloaded installation proofs", async () => {
  const remote = await recoveryRemote({ published: true })
  const result = await observe(remote.args)
  assert.equal(result.outcome, "complete", result.errors.join("; "))
  assert.deepEqual(
    Object.keys(result.facts.verification.installations).sort(),
    remote.installationAssets.map((ref) => ref.assetName).sort(),
  )
  for (const ref of remote.installationAssets) {
    assert.deepEqual(result.facts.verification.installations[ref.assetName], {
      ref,
      bytes: remote.raws.get(ref.assetName).toString("utf8"),
    })
  }
})
for (const [name, options] of [
  [
    "metadata omits one actual manifest package",
    {
      mutateLane(lane) {
        if (lane.lane === "metadata")
          lane.checks = lane.checks.filter((c) => c.name !== "package-b4run-sdk")
      },
    },
  ],
  [
    "storage reports only postgres",
    {
      mutateLane(lane) {
        if (lane.lane === "storage") lane.environment.dockerImages.shift()
      },
    },
  ],
  [
    "harness omits Docker identity",
    {
      mutateLane(lane) {
        if (lane.lane === "published-harness") lane.environment.dockerImages = []
      },
    },
  ],
  [
    "runtime reports storage Docker image",
    {
      mutateLane(lane) {
        if (lane.lane === "runtime-targets")
          lane.environment.dockerImages = [
            { reference: "postgres:16", digest: `sha256:${"a".repeat(64)}` },
          ]
      },
    },
  ],
  [
    "wrong sidecar count",
    {
      mutateLane(lane) {
        if (lane.lane === "storage") lane.installations[0].count++
      },
    },
  ],
  [
    "sidecar was not retained",
    {
      mutateSet(set) {
        set.retainedReceipts.pop()
      },
    },
  ],
  [
    "sidecar belongs to wrong executor",
    {
      mutateInstallation(value) {
        value.executor = { ...value.executor, runId: "999" }
      },
    },
  ],
  [
    "known subject hidden as dependency",
    {
      mutateInstallation(value) {
        value.resolutions.push({
          ...value.resolutions[0],
          installPath: "node_modules/z/node_modules/@b4run/sdk",
          subject: false,
          requested: "^0.7.0",
          resolved: "0.7.0",
        })
      },
    },
  ],
]) {
  test(`observer blocks canonical evidence when ${name}`, async () => {
    const remote = await recoveryRemote({ published: true, ...options })
    const result = await observe(remote.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
}

for (const mode of ["missing", "different"]) {
  test(`observer blocks ${mode} remotely downloaded installation bytes`, async () => {
    const remote = await recoveryRemote({ published: true })
    const ref = remote.installationAssets[0]
    const download = remote.args.github.downloadReleaseAsset.bind(remote.args.github)
    remote.args.github.downloadReleaseAsset = async (args) => {
      if (String(args.assetId) === ref.id)
        return mode === "missing"
          ? { status: "ABSENT", httpStatus: 404 }
          : {
              status: "PRESENT",
              contentBase64: Buffer.from("different bytes").toString("base64"),
            }
      return download(args)
    }
    const result = await observe(remote.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
}

test("valid older installation receipts remain retained diagnostic evidence", async () => {
  const previous = await recoveryRemote()
  const older = structuredClone(Object.values(previous.installationReceipts)[0])
  older.executor.runAttempt = "2"
  const remote = await recoveryRemote({
    published: true,
    retainedRaw: canonical(older).toString("utf8"),
  })
  const result = await observe(remote.args)
  assert.equal(result.outcome, "complete", result.errors.join("; "))
  assert.equal(Object.keys(result.facts.verification.installations).length, 7)
  assert.equal(result.facts.verification.set.retainedReceipts.length, 13)
})

test("selection without a retained trusted provenance descriptor cannot replay", async () => {
  const remote = await recoveryRemote({
    published: true,
    mutateSet: (set) => {
      set.retainedReceipts = set.retainedReceipts.filter(
        (ref) => !ref.assetName.startsWith("recovery-v2-provenance-"),
      )
    },
  })
  const result = await observe(remote.args)
  assert.equal(result.outcome, "blocked")
  assert.match(result.errors.join("; "), /trusted escrow descriptor/)
})

for (const field of ["jobId", "runId"])
  test(`partial escrow cannot invent its producer ${field}`, async () => {
    const { recoveryProvenanceName } = await import("../recovery/evidence-proof.mjs")
    const remote = await recoveryRemote()
    const original = remote.provenanceDescriptors[0]
    const descriptor = structuredClone(original)
    descriptor.executor[field] = "999"
    if (field === "runId") {
      // A canonical same-run descriptor may still claim a nonexistent real invocation.
      descriptor.provenance.executor.runId = "999"
      descriptor.artifact.name = descriptor.artifact.name.replace("-903-", "-999-")
      descriptor.receipt.assetName = `${descriptor.artifact.name}.json`
    }
    const forged = remote.add(recoveryProvenanceName(descriptor), descriptor)
    remote.setAssets([
      ...remote.baseAssets,
      remote.adoption.archive,
      remote.adoptionRef,
      ...remote.installationAssets,
      ...remote.set.lanes.map((l) => l.receipt),
      forged,
    ])
    remote.release.body = metadata.renderRecoveryReleaseBody({
      marker: remote.marker,
      body: "Notes",
    })
    const result = await observe(remote.args)
    assert.equal(result.outcome, "blocked")
    assert.match(result.errors.join("; "), /producer (job|run) identity/)
  })

test("unreserved pre-adoption inspection proves original payload without granting writer facts", async () => {
  const r = await recoveryRemote()
  r.args.git.listTree = async () => ""
  r.args.git.showFile = async ({ path }) => {
    if (path.endsWith("policy.json")) return canonical(r.policy).toString()
    throw new Error("no committed admission")
  }
  assert.equal(typeof observer.inspectRecoveryOriginalPayload, "function")
  const result = await observer.inspectRecoveryOriginalPayload(r.args)
  assert.equal(result.status, "unreserved")
  assert.equal(result.originalPayload.npmEvidence.conclusion, "success")
  assert.equal(result.originalPayload.assets.length, r.baseAssets.length)
  assert.equal(Object.hasOwn(result, "facts"), false)
  assert.equal(result.proposal.policySha256, r.intent.policySha256)
  assert.equal((await observe(r.args)).outcome, "blocked")
})

test("pre-adoption inspection rejects foreign original proof", async () => {
  const r = await recoveryRemote()
  r.args.candidate = { ...r.c, manifestSha256: "0".repeat(64) }
  assert.equal(typeof observer.inspectRecoveryOriginalPayload, "function")
  const result = await observer.inspectRecoveryOriginalPayload(r.args)
  assert.equal(result.status, "blocked")
  assert.equal(result.originalPayload, null)
  assert.equal(result.proposal, null)
})

test("pre-adoption inspection reports a committed reservation without a duplicate proposal", async () => {
  const r = await recoveryRemote()
  const result = await observer.inspectRecoveryOriginalPayload(r.args)
  assert.equal(result.status, "recovery-required")
  assert.equal(result.proposal, null)
  assert.equal(result.reservation.intentPath, r.intentPath)
  assert.equal(result.originalPayload.npmEvidence.conclusion, "success")
})
for (const [name, change] of [
  [
    "conflicting candidate",
    (r) => {
      r.intent.candidate = { ...r.c, candidateSha: "d".repeat(40) }
    },
  ],
  [
    "foreign repository with same release ID",
    (r) => {
      r.intent.candidate = {
        ...r.c,
        repository: "foreign/project",
        repositoryId: "999",
      }
    },
  ],
  [
    "ambiguous reservation",
    (r) => {
      r.args.git.listTree = async () => `${r.intentPath}\n${r.intentPath}`
    },
  ],
  [
    "malformed inventory",
    (r) => {
      r.args.git.listTree = async () => ({ paths: [r.intentPath] })
    },
  ],
  [
    "malformed committed intent",
    (r) => {
      const show = r.args.git.showFile
      r.args.git.showFile = async (a) => (a.path === r.intentPath ? "{}" : show(a))
    },
  ],
  [
    "changed policy digest",
    (r) => {
      r.intent.policySha256 = "0".repeat(64)
    },
  ],
  [
    "changed legacy body digest",
    (r) => {
      r.intent.legacyBodySha256 = "0".repeat(64)
    },
  ],
])
  test(`pre-adoption ${name} blocks while retaining verified original payload`, async () => {
    const r = await recoveryRemote()
    change(r)
    const result = await observer.inspectRecoveryOriginalPayload(r.args)
    assert.equal(result.status, "blocked")
    assert.equal(result.proposal, null)
    assert.equal(result.originalPayload.npmEvidence.conclusion, "success")
  })

test("an unrelated foreign reservation does not reserve the inspected candidate", async () => {
  const r = await recoveryRemote()
  r.intent.candidate = {
    ...r.c,
    repository: "foreign/project",
    repositoryId: "999",
    releaseId: "998",
  }
  const result = await observer.inspectRecoveryOriginalPayload(r.args)
  assert.equal(result.status, "unreserved")
  assert.deepEqual(result.proposal.candidate, r.c)
})
test("unsafe admission inventory paths cannot become an empty reservation inventory", async () => {
  const r = await recoveryRemote()
  r.args.git.listTree = async () => "scripts/release/recovery-adoptions/unsafe name.json"
  const result = await observer.inspectRecoveryOriginalPayload(r.args)
  assert.equal(result.status, "blocked")
  assert.equal(result.proposal, null)
  assert.equal(result.originalPayload.npmEvidence.conclusion, "success")
})

test("each fresh observation verifies one complete npm inventory batch after all fresh bytes", async () => {
  const r = await recoveryRemote()
  let factories = 0,
    commands = 0,
    downloads = 0
  const create = r.args.npmAuditFactory.create
  const download = r.args.npm.downloadRegistryTarball
  r.args.npm.downloadRegistryTarball = async (args) => {
    downloads++
    return download(args)
  }
  r.args.npmAuditFactory.create = async () => {
    factories++
    const verifier = await create()
    return {
      ...verifier,
      async verifyPackages(args) {
        commands++
        assert.equal(downloads, commands * r.base.manifest.packages.length)
        assert.deepEqual(
          args.entries,
          [...r.base.manifest.packages].sort((a, b) => (a.name < b.name ? -1 : 1)),
        )
        return verifier.verifyPackages(args)
      },
      async verifyPackage() {
        throw new Error("per-package audit must not run")
      },
    }
  }
  for (let i = 0; i < 2; i++) {
    const result = await observe(r.args)
    assert.equal(result.outcome, "recovery-required", result.errors.join("; "))
  }
  assert.equal(factories, 2)
  assert.equal(commands, 2)
  assert.equal(downloads, 2 * r.base.manifest.packages.length)
})
for (const mutation of ["missing", "duplicate", "reordered", "foreign", "extra field", "null"])
  test(`observer rejects ${mutation} batch result`, async () => {
    const r = await recoveryRemote()
    const create = r.args.npmAuditFactory.create
    r.args.npmAuditFactory.create = async () => {
      const verifier = await create()
      return {
        ...verifier,
        async verifyPackages(args) {
          const rows = structuredClone(await verifier.verifyPackages(args))
          if (mutation === "missing") rows.pop()
          if (mutation === "duplicate") rows[1] = rows[0]
          if (mutation === "reordered") rows.reverse()
          if (mutation === "foreign") rows[1].name = "foreign"
          if (mutation === "extra field") rows[1].extra = true
          if (mutation === "null") rows[1] = null
          return rows
        },
      }
    }
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
  })

test("a created verifier missing the required batch method is still disposed", async () => {
  const r = await recoveryRemote()
  let disposed = 0
  r.args.npmAuditFactory.create = async () => ({
    verifyPackage: async () => {},
    dispose: async () => {
      disposed++
    },
  })
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(disposed, 1)
})

async function repairedRemote() {
  const { verifierRepairFixture } = await import("./support/recovery-verifier-repair-fixture.mjs")
  const remote = await recoveryRemote({
    configureFence: async ({ candidate, executor, policy, source }) => {
      const repair = await verifierRepairFixture({
        candidate,
        baseline: executor.controllerSha,
        current: "d".repeat(40),
        source,
      })
      Object.assign(policy, repair.request.policy)
      executor.verifierClosureSha256 = policy.verifierClosure.sha256
      return repair
    },
  })
  remote.adoptionRef = remote.add(
    `recovery-v2-adoption-${remote.e.controllerSha}-${remote.e.runId}-${remote.e.runAttempt}-${remote.e.jobId}.json`,
    remote.adoption,
  )
  remote.marker.adoption = remote.adoptionRef
  remote.fence.record.adoption = remote.adoptionRef
  remote.fence.refresh()
  remote.args.controllerRef = remote.fence.current
  remote.release.body = metadata.renderRecoveryReleaseBody({
    marker: remote.marker,
    body: "Notes",
  })
  remote.setAssets([...remote.baseAssets, remote.adoption.archive, remote.adoptionRef])
  return remote
}
test("repaired current controller observes the original adopted receipt", async () => {
  const r = await repairedRemote()
  const result = await observe(r.args)
  assert.equal(result.phase, "RECOVERY_ADOPTED", JSON.stringify(result.errors))
  assert.equal(result.outcome, "recovery-required", JSON.stringify(result.errors))
})
test("repaired controller rejects a different original adoption descriptor", async () => {
  const r = await repairedRemote()
  r.fence.record.adoption = { ...r.adoptionRef, id: "999999" }
  r.fence.refresh()
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked", JSON.stringify(result.errors))
})

async function mixedRepairRemote() {
  const r = await repairedRemote()
  const repairedLane = {
    ...r.lanes.metadata,
    executor: {
      ...r.lanes.metadata.executor,
      controllerSha: r.fence.current,
      verifierClosureSha256: r.fence.record.replacementClosureSha256,
    },
  }
  const repairedRef = r.add("recovery-v2-lane-repaired-metadata.json", repairedLane)
  r.set.retainedReceipts.push(repairedRef)
  r.set.retainedReceipts.sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
  const setRef = r.add(r.setRef.assetName, r.set)
  const github = r.args.github
  const list = github.listWorkflowRuns,
    attempt = github.getActionsRunAttempt,
    checks = github.getCommitCheckRuns
  const repairCi = (ci) => ({
    ...ci,
    id: 701,
    head_sha: r.fence.current,
    check_suite_id: 901,
  })
  github.listWorkflowRuns = async (args) => {
    const result = await list(args)
    return args.commitSha === r.fence.current
      ? { ...result, value: result.value.map(repairCi) }
      : result
  }
  github.getActionsRunAttempt = async (args) => {
    const result = await attempt(args)
    return args.runId === "701" ? { ...result, value: repairCi(result.value) } : result
  }
  github.getCommitCheckRuns = async (args) => {
    const result = await checks(args)
    return args.commitSha === r.fence.current
      ? {
          ...result,
          value: result.value.map((check) => ({
            ...check,
            head_sha: r.fence.current,
            check_suite: { id: 901 },
          })),
        }
      : result
  }
  const marker = {
    ...r.marker,
    phase: "VERIFICATION_COMPLETE",
    revision: 2,
    verificationSet: setRef,
  }
  r.release.body = metadata.renderRecoveryReleaseBody({
    marker,
    body: "notes",
  })
  r.setAssets([
    ...r.allAssets.filter(
      (a) =>
        !a.assetName.includes("audit") &&
        a.assetName !== "recovery-v2-finalization.json" &&
        a.assetName !== "recovery-v2-adoption-903-1.json" &&
        a.assetName !== setRef.assetName,
    ),
    r.adoptionRef,
    setRef,
    repairedRef,
  ])
  return r
}

test("mixed original adoption and repaired historical lane executor remain verifiable", async () => {
  const r = await mixedRepairRemote()
  const result = await observe(r.args)
  assert.equal(result.outcome, "recovery-required", JSON.stringify(result.errors))
  assert.ok(result.facts.verification)
})

async function secondRepairRemote() {
  const { canonicalPolicyBytes, hashVerifierClosure } = await import("../recovery/policy.mjs")
  const { digest } = await import("./support/recovery-fixture.mjs")
  const r = await mixedRepairRemote()
  const secondSha = "e".repeat(40)
  const repairPath = "scripts/release/recovery-verifier-repairs/v0.8.24.json"
  const sourcePath = "scripts/release/smoke/runtime-targets.mjs"
  for (const [key, raw] of [...r.fence.files])
    if (key.startsWith(`${r.fence.current}:`))
      r.fence.files.set(`${secondSha}:${key.slice(41)}`, raw)
  r.fence.files.set(`${secondSha}:${sourcePath}`, "// second independently reviewed repair\n")
  const record = structuredClone(r.fence.record)
  record.inputs.find((input) => input.path === sourcePath).newSha256 = digest(
    r.fence.files.get(`${secondSha}:${sourcePath}`),
  )
  record.replacementClosureSha256 = await hashVerifierClosure(
    { controllerSha: secondSha, inputs: record.inputs.map((input) => input.path) },
    ({ ref, path }) => r.fence.files.get(`${ref}:${path}`),
  )
  const contract = structuredClone(r.fence.replacementContract)
  contract.topology[0].sources[0].executionInputs[0].sha256 = record.inputs.find(
    (input) => input.path === sourcePath,
  ).newSha256
  const contractBytes = canonicalPolicyBytes(contract).toString()
  record.replacementContractSha256 = digest(contractBytes)
  r.fence.files.set(
    `${secondSha}:scripts/release/recovery-fence-contracts/${record.replacementContractSha256}.json`,
    contractBytes,
  )
  r.fence.files.set(`${secondSha}:${repairPath}`, canonicalPolicyBytes(record).toString())
  r.args.controllerRef = secondSha
  const reads = []
  const show = r.args.git.showFile
  r.args.git.showFile = async (args) => {
    reads.push(args)
    return show(args)
  }
  return { r, secondSha, repairPath, reads }
}

test("second repair current admission preserves first repair historical lane receipts", async () => {
  const { r, secondSha, repairPath, reads } = await secondRepairRemote()
  const result = await observe(r.args)
  assert.equal(result.outcome, "recovery-required", JSON.stringify(result.errors))
  assert.ok(result.facts.verification)
  for (const ref of [r.fence.current, secondSha])
    assert.ok(
      reads.some((read) => read.ref === ref && read.path === repairPath),
      `repair record must be read at its own immutable executor ${ref}`,
    )
})

for (const damaged of ["historical", "current"])
  test(`second repair cannot cover a damaged ${damaged} repair record`, async () => {
    const { r, secondSha, repairPath } = await secondRepairRemote()
    const ref = damaged === "historical" ? r.fence.current : secondSha
    r.fence.files.set(`${ref}:${repairPath}`, "{}\n")
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked", JSON.stringify(result.errors))
    assert.match(result.errors.join(" "), /exact fields required/)
  })
