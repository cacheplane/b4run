import assert from "node:assert/strict"
import test from "node:test"
import { authorizeFenceProbe, classifyFenceProbe } from "./support/recovery-github-fence.mjs"

const env = {
  B4_TEST_RECOVERY_GITHUB: "1",
  B4_RECOVERY_TEST_REPOSITORY: "example/release-lab",
  B4_RECOVERY_AUTHORIZED_REPOSITORY: "example/release-lab",
}

test("fence experiment requires an enabled, explicitly authorized disposable repository", () => {
  assert.equal(authorizeFenceProbe(env), "example/release-lab")
  for (const key of Object.keys(env)) {
    assert.throws(() => authorizeFenceProbe({ ...env, [key]: "" }), /required|authorized/)
  }
  for (const repository of [
    "cacheplane/b4run",
    "CachePlane/B4Run",
    "cacheplane/dawnai",
    "CachePlane/DawnAI",
    "../b4run",
    "a/b/c",
  ]) {
    assert.throws(
      () =>
        authorizeFenceProbe({
          ...env,
          B4_RECOVERY_TEST_REPOSITORY: repository,
          B4_RECOVERY_AUTHORIZED_REPOSITORY: repository,
        }),
      /production|repository/,
    )
  }
  assert.throws(
    () =>
      authorizeFenceProbe({
        ...env,
        B4_RECOVERY_AUTHORIZED_REPOSITORY: "example/another",
      }),
    /authorized/,
  )
})

const methods = ["dispatch", "all", "failed", "job"]
const samples = () =>
  methods.flatMap((method) => [
    { stage: "active-before", method, accepted: true },
    { stage: "disabled", method, accepted: false, status: 422, unchanged: true },
    { stage: "active-after", method, accepted: true },
  ])

test("disabled acceptance disproves a workflow-disable fence", () => {
  for (const method of methods) {
    const observations = samples()
    const disabled = observations.find(
      (item) => item.method === method && item.stage === "disabled",
    )
    disabled.accepted = true
    assert.equal(classifyFenceProbe(observations), "workflow-disable-insufficient")
  }
})

test("denials require complete positive controls and unchanged attempts", () => {
  assert.equal(classifyFenceProbe(samples()), "disposable-fence-observed")
  for (const index of samples().keys()) {
    assert.equal(classifyFenceProbe(samples().filter((_, i) => i !== index)), "inconclusive")
  }
  for (const override of [{ status: 500 }, { status: 401 }, { unchanged: false }]) {
    const observations = samples()
    Object.assign(
      observations.find((item) => item.stage === "disabled"),
      override,
    )
    assert.equal(classifyFenceProbe(observations), "inconclusive")
  }
  assert.equal(classifyFenceProbe([...samples(), samples()[0]]), "inconclusive")
})
