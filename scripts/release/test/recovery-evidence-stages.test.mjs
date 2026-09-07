import assert from "node:assert/strict"
import test from "node:test"
import * as cli from "../recovery/cli.mjs"
import * as evidence from "../recovery/evidence.mjs"
import { evidenceRemote } from "./support/recovery-evidence-fixture.mjs"

const stage = (r, previous = null) =>
  evidence.collectRecoveryEvidenceStage(r.request, r.config, r.dependencies, previous)
test("three deterministic complete-lane groups retain selection and marker until the final group", async () => {
  const r = await evidenceRemote()
  const first = await stage(r)
  assert.deepEqual(first.stage.completedLanes, ["metadata", "published-harness"])
  assert.equal(first.result.phase, "RECOVERY_ADOPTED")
  assert.equal(r.effects.length, 7)
  const second = await stage(r, first.stage)
  assert.deepEqual(second.stage.completedLanes, [
    "metadata",
    "published-harness",
    "runtime-targets",
    "scaffold",
  ])
  assert.equal(second.result.phase, "RECOVERY_ADOPTED")
  assert.equal(r.effects.length, 14)
  const third = await stage(r, second.stage)
  assert.equal(third.result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
  assert.equal(r.effects.at(-1).method, "PATCH")
  const replay = await stage(r)
  assert.equal(replay.result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
})
test("stages validate every remaining artifact before the first group writes", async () => {
  const r = await evidenceRemote()
  r.artifacts.pop()
  const result = await stage(r)
  assert.ok(result.result.errors.length)
  assert.equal(result.stage, null)
  assert.equal(r.effects.length, 0)
})
test("prior executor and completed-lane drift block a new stage before writes", async () => {
  for (const change of [
    (s) => {
      s.executor.jobId = "999999"
    },
    (s) => {
      s.completedLanes.push("storage")
    },
  ]) {
    const r = await evidenceRemote()
    const first = await stage(r)
    const previous = structuredClone(first.stage)
    change(previous)
    const count = r.effects.length
    await assert.rejects(stage(r, previous), /executor|progress/)
    assert.equal(r.effects.length, count)
  }
})
test("CLI stage orchestration awaits disposal before creating a fresh scope", async () => {
  const r = await evidenceRemote()
  let created = 0,
    disposed = 0
  const completed = []
  const result = await cli.runRecoveryEvidenceStages(
    r.request,
    async () => {
      assert.equal(created, disposed)
      created++
      return {
        ...r.dependencies,
        config: r.config,
        dispose: async () => {
          await new Promise((resolve) => setImmediate(resolve))
          disposed++
        },
      }
    },
    (s) => completed.push(s),
  )
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(created, 3)
  assert.equal(disposed, 3)
  assert.equal(completed.length, 3)
})
test("CLI stages stop on disposal failure or transport identity drift", async () => {
  for (const failure of ["dispose", "transport"]) {
    const r = await evidenceRemote()
    let created = 0
    const completed = []
    await assert.rejects(
      cli.runRecoveryEvidenceStages(
        r.request,
        async () => {
          created++
          return {
            ...r.dependencies,
            config: r.config,
            fetchImpl:
              failure === "transport" && created > 1 ? async () => {} : r.dependencies.fetchImpl,
            dispose: async () => {
              if (failure === "dispose") throw new Error("disposal failed")
            },
          }
        },
        (s) => completed.push(s),
      ),
      /disposal|transport/,
    )
    assert.equal(r.effects.length, 7)
    assert.equal(created, failure === "dispose" ? 1 : 2)
  }
})

test("each fixed group keeps the original twenty-minute budget while the command spans longer", async () => {
  const r = await evidenceRemote()
  let now = r.dependencies.authority.now()
  const start = now
  r.dependencies.authority.now = () => now
  const fence = r.dependencies.authority.observeLegacyFence
  r.dependencies.authority.observeLegacyFence = async () => ({
    ...(await fence()),
    observedAt: now,
    expiresAt: now + 30000,
  })
  const send = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const response = await send(...args)
    now += 80000
    return response
  }
  let runtimes = 0
  const result = await cli.runRecoveryEvidenceStages(r.request, async () => {
    runtimes++
    return { ...r.dependencies, config: r.config }
  })
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(runtimes, 3)
  assert.ok(now - start > 1200000)
  assert.equal(r.effects.length, 19)
})

async function cliFixture(r, customize = (value) => value) {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { canonicalRequestBytes } = await import("../recovery/requests.mjs")
  const directory = await mkdtemp(join(tmpdir(), "recovery-stage-cli-"))
  let created = 0
  try {
    const request = join(directory, "request.json"),
      output = join(directory, "output.json")
    await writeFile(request, canonicalRequestBytes(r.request))
    const result = await cli.runRecoveryCli(
      ["reconcile-verification", "--request", request, "--output", output],
      {
        root: directory,
        environment: {},
        createRuntime: async () => {
          created++
          return customize({ ...r.dependencies, config: r.config }, created)
        },
      },
    )
    return { ...result, created, diagnostic: JSON.parse(await readFile(output, "utf8")) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
test("actual CLI dispatch runs three stages and persists their final diagnostics", async () => {
  const r = await evidenceRemote()
  const result = await cliFixture(r)
  assert.equal(result.exitCode, 0)
  assert.equal(result.created, 3)
  assert.equal(result.diagnostic.evidenceStages.length, 3)
  assert.equal(result.diagnostic.result.phase, "VERIFICATION_COMPLETE")
})
test("actual CLI failure preserves earlier successful stages and never continues", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(8)
  const result = await cliFixture(r)
  assert.equal(result.exitCode, 1)
  assert.equal(result.created, 2)
  assert.equal(result.diagnostic.evidenceStages.length, 1)
  assert.deepEqual(result.diagnostic.evidenceStages[0].completedLanes, [
    "metadata",
    "published-harness",
  ])
  assert.equal(r.effects.length, 8)
})
test("actual CLI missing-artifact and phase-timeout failures cannot start another runtime", async () => {
  for (const failure of ["missing", "timeout"]) {
    const r = await evidenceRemote()
    if (failure === "missing") r.artifacts.pop()
    else {
      let now = r.dependencies.authority.now()
      r.dependencies.authority.now = () => now
      const read = r.args.github.getRelease
      r.args.github.getRelease = async (...args) => {
        const value = await read(...args)
        now += 1200000
        return value
      }
    }
    const result = await cliFixture(r)
    assert.equal(result.exitCode, 1)
    assert.equal(result.created, 1)
    assert.equal(result.diagnostic.evidenceStages.length, 0)
    assert.equal(r.effects.length, 0)
  }
})
for (const interrupted of [13, 17])
  test(`actual CLI resumes ${interrupted} retained uploads with complete group boundaries`, async () => {
    const r = await evidenceRemote()
    r.interruptAfter(interrupted)
    await assert.rejects(evidence.collectRecoveryEvidence(r.request, r.config, r.dependencies))
    assert.equal(r.effects.length, interrupted)
    const result = await cliFixture(r)
    assert.equal(result.exitCode, 0)
    assert.equal(result.created, interrupted === 13 ? 2 : 1)
    assert.equal(r.effects.length, 19)
    assert.equal(new Set(r.assets().map((a) => a.assetName)).size, r.assets().length)
  })
test("an accepted prior-executor selection resumes only its marker without new lane escrow", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(18)
  await assert.rejects(evidence.collectRecoveryEvidence(r.request, r.config, r.dependencies))
  assert.equal(r.effects.length, 18)
  r.execution.jobId = "99999"
  const result = await cliFixture(r)
  assert.equal(result.exitCode, 0)
  assert.equal(result.created, 1)
  assert.equal(r.effects.length, 19)
  assert.equal(r.effects.at(-1).method, "PATCH")
})
