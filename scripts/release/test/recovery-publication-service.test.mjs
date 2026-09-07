import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"

const historicalWorkflow = await readFile(
  "scripts/release/test/fixtures/recovery-contract-workflow.yml",
  "utf8",
)
const currentWorkflow = await readFile(
  "scripts/release/test/fixtures/recovery-contract-workflow-current.yml",
  "utf8",
)

const subject = await import("./support/recovery-publication-service.mjs").catch(() => ({}))
const sha = (x) => createHash("sha256").update(x).digest("hex")
function service({
  uncertain = null,
  production = false,
  immutable = true,
  existingRelease = false,
} = {}) {
  const calls = [],
    effects = [],
    base = "/repos/example/release-lab"
  const nonce = "01234567-1234-1234-1234-123456789abc",
    sourceSha = "a".repeat(40)
  let release = existingRelease
      ? {
          id: 100,
          tag_name: `v0.0.0-recovery-contract-${nonce}`,
          target_commitish: sourceSha,
          name: `Recovery service contract ${nonce}`,
          body: `Disposable contract ${nonce}; payload sha256:${sha(Buffer.from(`Recovery service contract ${nonce}\nsource ${sourceSha}\n`))}`,
          draft: true,
          immutable: false,
          prerelease: true,
        }
      : undefined,
    asset,
    payload
  return {
    calls,
    effects,
    repository: "example/release-lab",
    sourceSha: "a".repeat(40),
    nonce: "01234567-1234-1234-1234-123456789abc",
    async api(method, path, body) {
      calls.push({ method, path })
      if (method === "GET") {
        if (path.includes("/actions/workflows?"))
          return {
            status: 200,
            body: {
              total_count: 1,
              workflows: [{ id: 12, path: ".github/workflows/recovery-fence-probe.yml" }],
            },
          }
        if (path === base)
          return {
            status: 200,
            body: {
              id: production ? 1360603908 : 42,
              full_name: "example/release-lab",
              default_branch: "main",
              private: false,
            },
          }
        if (path.endsWith("/immutable-releases"))
          return { status: 200, body: { enabled: immutable, enforced_by_owner: false } }
        if (path.includes("/git/ref/heads/"))
          return { status: 200, body: { object: { sha: "b".repeat(40), type: "commit" } } }
        if (path.includes("/contents/"))
          return {
            status: 200,
            body: {
              encoding: "base64",
              content: Buffer.from(
                path.endsWith("a".repeat(40)) ? historicalWorkflow : currentWorkflow,
              ).toString("base64"),
            },
          }
        if (path.includes("/git/ref/tags/"))
          return { status: 200, body: { object: { sha: "c".repeat(40), type: "tag" } } }
        if (path.includes("/git/tags/"))
          return { status: 200, body: { object: { sha: "a".repeat(40), type: "commit" } } }
        if (path.endsWith("/assets?per_page=100&page=1"))
          return { status: 200, body: asset ? [asset] : [] }
        if (path.endsWith("/releases/100")) return { status: 200, body: release }
      }
      effects.push({ method, path, body })
      if (path.endsWith("/git/tags")) return { status: 201, body: { sha: "c".repeat(40) } }
      if (path.endsWith("/git/refs")) return { status: 201, body: {} }
      if (method === "POST" && path.endsWith("/releases")) {
        release = { ...body, id: 100, tag_name: "untagged-fixture", immutable: false }
        if (uncertain === "create")
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 201, body: release }
      }
      if (method === "POST" && path.includes("/assets?name=")) {
        payload = body
        asset = { id: 200, name: "contract.txt", size: body.length, digest: `sha256:${sha(body)}` }
        if (uncertain === "upload")
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 201, body: asset }
      }
      if (method === "PATCH") {
        release = { ...release, ...body, ...(body.draft === false ? { immutable: true } : {}) }
        if (uncertain === "publish" && body.draft === false)
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 200, body: release }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
    async anonymousGet() {
      return { status: release.draft ? 404 : 200, body: release.draft ? null : release }
    },
    async download() {
      return payload
    },
  }
}
for (const uncertain of [null, "upload", "publish"]) {
  test(`publication service contract reads back exact immutable payload with ${uncertain ?? "known"} response`, async () => {
    assert.equal(typeof subject.runPublicationServiceProbe, "function")
    const fake = service({ uncertain })
    const result = await subject.runPublicationServiceProbe(fake)
    assert.equal(result.status, "published-immutable")
    assert.equal(fake.effects.filter((e) => e.path.endsWith("/releases")).length, 1)
    assert.equal(fake.effects.filter((e) => e.path.includes("/assets?")).length, 1)
    assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
  })
}
test("publication probe refuses production aliases and disabled immutability before mutations", async () => {
  for (const options of [{ production: true }, { immutable: false }]) {
    const fake = service(options)
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(fake.effects.length, 0)
  }
})
test("unknown draft creation stops without a duplicate creation or inferred resource ID", async () => {
  const fake = service({ uncertain: "create" })
  await assert.rejects(subject.runPublicationServiceProbe(fake), /response lost/)
  assert.equal(fake.effects.filter((e) => e.path.endsWith("/releases")).length, 1)
  assert.equal(
    fake.effects.some((e) => e.method === "PATCH"),
    false,
  )
})

test("asset readback compares immutable identity rather than mutable download counters", async () => {
  const fake = service()
  const api = fake.api
  let count = 0
  fake.api = async (...args) => {
    const r = await api(...args)
    if (args[1].endsWith("/assets?per_page=100&page=1"))
      r.body = r.body.map((asset) => ({ ...asset, download_count: count++ }))
    return r
  }
  assert.equal((await subject.runPublicationServiceProbe(fake)).status, "published-immutable")
})

for (const damage of ["draft-visible", "payload", "asset-digest", "asset-size", "asset-extra"]) {
  test(`publication probe blocks ${damage} before publication`, async () => {
    const fake = service()
    if (damage === "draft-visible") fake.anonymousGet = async () => ({ status: 200, body: {} })
    if (damage === "payload") fake.download = async () => Buffer.from("changed payload")
    const api = fake.api
    fake.api = async (...args) => {
      const r = await api(...args)
      if (args[1].endsWith("/assets?per_page=100&page=1")) {
        r.body = structuredClone(r.body)
        if (damage === "asset-digest") r.body[0].digest = `sha256:${"0".repeat(64)}`
        if (damage === "asset-size") r.body[0].size++
        if (damage === "asset-extra") r.body.push({ ...r.body[0], id: 201 })
      }
      return r
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(
      fake.effects.some((e) => e.method === "PATCH"),
      false,
    )
  })
}

test("publication refuses unrelated workflow identities before tag or release creation", async () => {
  const fake = service()
  const api = fake.api
  fake.api = async (...args) => {
    if (args[1].includes("/actions/workflows?"))
      return {
        status: 200,
        body: {
          total_count: 1,
          workflows: [{ id: 999, path: ".github/workflows/unrelated-release-writer.yml" }],
        },
      }
    return api(...args)
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /workflow/)
  assert.equal(fake.effects.length, 0)
})

test("default branch movement after upload blocks publication", async () => {
  const fake = service()
  const api = fake.api
  fake.api = async (...args) => {
    const r = await api(...args)
    if (
      args[1].includes("/git/ref/heads/") &&
      fake.effects.some((e) => e.path.includes("/assets?"))
    )
      r.body = { object: { type: "commit", sha: "d".repeat(40) } }
    return r
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /default branch/)
  assert.equal(
    fake.effects.some((e) => e.method === "PATCH"),
    false,
  )
})

test("publication service download decodes the production binary envelope without changing bytes", async () => {
  assert.equal(typeof subject.downloadPublicationAsset, "function")
  const bytes = Buffer.from([0, 255, 195, 40, 10])
  const calls = []
  const reader = createGitHubReader({
    owner: "example",
    repo: "release-lab",
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
    },
  })
  assert.deepEqual(await subject.downloadPublicationAsset(reader, 200), bytes)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.github.com/repos/example/release-lab/releases/assets/200")
  assert.equal(calls[0].init.headers.Accept, "application/octet-stream")
})

test("publication service download refuses a failed production read", async () => {
  assert.equal(typeof subject.downloadPublicationAsset, "function")
  const reader = createGitHubReader({
    owner: "example",
    repo: "release-lab",
    fetchImpl: async () => new Response("missing", { status: 404 }),
  })
  await assert.rejects(subject.downloadPublicationAsset(reader, 200), /production asset adapter/)
})

test("publication visibility may settle after authenticated immutable publication without another write", async () => {
  const fake = service()
  const original = fake.anonymousGet
  let postPublishReads = 0
  const sleeps = []
  fake.sleep = async (ms) => sleeps.push(ms)
  fake.anonymousGet = async () => {
    const response = await original()
    if (response.status === 200 && postPublishReads++ < 2) return { status: 404, body: null }
    return response
  }
  assert.equal((await subject.runPublicationServiceProbe(fake)).status, "published-immutable")
  assert.deepEqual(sleeps, [5000, 5000])
  assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
})

test("publication visibility settlement is bounded and does not retry non-404 failures", async () => {
  for (const status of [404, 403]) {
    const fake = service()
    const original = fake.anonymousGet
    const sleeps = []
    fake.sleep = async (ms) => sleeps.push(ms)
    fake.anonymousGet = async () => {
      const response = await original()
      return response.status === 200 ? { status, body: null } : response
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(sleeps.length, status === 404 ? 11 : 0)
    assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
  }
})

function existingTagService(options) {
  const fake = service(options)
  fake.existingTagObjectSha = "c".repeat(40)
  const api = fake.api
  fake.api = async (method, path, body) => {
    if (method === "GET" && path.includes("/releases?")) {
      fake.calls.push({ method, path })
      return { status: 200, body: [] }
    }
    if (method === "GET" && path.includes("/git/commits/")) {
      fake.calls.push({ method, path })
      return { status: 200, body: { sha: fake.sourceSha } }
    }
    const response = await api(method, path, body)
    if (method === "GET" && path.includes("/git/ref/tags/"))
      response.body.ref = `refs/tags/v0.0.0-recovery-contract-${fake.nonce}`
    if (method === "GET" && path.includes("/git/tags/"))
      Object.assign(response.body, {
        sha: fake.existingTagObjectSha,
        tag: `v0.0.0-recovery-contract-${fake.nonce}`,
      })
    return response
  }
  return fake
}
for (const uncertain of [null, "upload", "publish"])
  test(`existing operator tag supports ${uncertain ?? "known"} publication response without tag mutations`, async () => {
    const fake = existingTagService({ uncertain })
    const result = await subject.runPublicationServiceProbe(fake)
    assert.equal(result.status, "published-immutable")
    assert.equal(result.tagProvenance, "operator-created")
    assert.equal(
      fake.effects.some((e) => e.path.includes("/git/")),
      false,
    )
    assert.equal(fake.effects.filter((e) => e.path.endsWith("/releases")).length, 1)
    assert.equal(fake.effects.filter((e) => e.path.includes("/assets?")).length, 1)
    assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
    assert.ok(fake.calls.some((e) => e.path.includes(`/git/commits/${fake.sourceSha}`)))
  })
for (const damage of [
  "wrong-ref",
  "lightweight",
  "wrong-object",
  "wrong-tag-name",
  "wrong-object-sha",
  "wrong-target",
  "wrong-commit",
  "preexisting-release",
  "preexisting-draft",
  "unavailable-inventory",
  "incomplete-inventory",
])
  test(`existing-tag preflight rejects ${damage} before writes`, async () => {
    const fake = existingTagService()
    const api = fake.api
    fake.api = async (...args) => {
      const response = await api(...args),
        path = args[1]
      if (args[0] !== "GET") return response
      if (path.includes("/git/ref/tags/")) {
        if (damage === "wrong-ref") response.body.ref += "-other"
        if (damage === "lightweight") response.body.object.type = "commit"
        if (damage === "wrong-object") response.body.object.sha = "d".repeat(40)
      }
      if (path.includes("/git/tags/")) {
        if (damage === "wrong-tag-name") response.body.tag += "-other"
        if (damage === "wrong-object-sha") response.body.sha = "d".repeat(40)
        if (damage === "wrong-target") response.body.object.sha = "d".repeat(40)
      }
      if (path.includes("/git/commits/") && damage === "wrong-commit")
        response.body.sha = "d".repeat(40)
      if (path.includes("/releases?")) {
        if (damage === "preexisting-release")
          response.body = [
            { id: 99, tag_name: `v0.0.0-recovery-contract-${fake.nonce}`, name: "other", body: "" },
          ]
        if (damage === "preexisting-draft")
          response.body = [
            {
              id: 99,
              tag_name: "untagged-old",
              name: `Recovery service contract ${fake.nonce}`,
              body: "",
            },
          ]
        if (damage === "unavailable-inventory") response.status = 403
        if (damage === "incomplete-inventory")
          response.body = Array(100).fill({ id: 99, tag_name: "other", name: "other", body: "" })
      }
      return response
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.deepEqual(fake.effects, [])
  })
test("existing tag mode rejects malformed object identity before any call", async () => {
  const fake = existingTagService()
  fake.existingTagObjectSha = "invalid"
  await assert.rejects(subject.runPublicationServiceProbe(fake))
  assert.deepEqual(fake.calls, [])
})

function existingReleaseService(options) {
  const fake = existingTagService({ ...options, existingRelease: true })
  fake.existingReleaseId = 100
  const api = fake.api
  fake.api = async (method, path, body) => {
    if (method === "GET" && path.includes("/releases?")) {
      fake.calls.push({ method, path })
      return {
        status: 200,
        body: [(await api("GET", "/repos/example/release-lab/releases/100", null)).body],
      }
    }
    return api(method, path, body)
  }
  return fake
}
for (const uncertain of [null, "upload", "publish"])
  test(`existing empty operator draft supports ${uncertain ?? "known"} response without resource creation`, async () => {
    const fake = existingReleaseService({ uncertain })
    const initialBody = (await fake.api("GET", "/repos/example/release-lab/releases/100", null))
      .body.body
    const result = await subject.runPublicationServiceProbe(fake)
    assert.equal(result.status, "published-immutable")
    assert.equal(result.releaseProvenance, "operator-created")
    assert.equal(
      fake.effects.some((e) => e.path.includes("/git/") || e.path.endsWith("/releases")),
      false,
    )
    assert.equal(fake.effects.filter((e) => e.path.includes("/assets?")).length, 1)
    const patches = fake.effects.filter((e) => e.method === "PATCH")
    assert.equal(patches.length, 2)
    assert.deepEqual(Object.keys(patches[0].body), ["body"])
    assert.equal(
      patches[0].body.body,
      `${initialBody}\n\nMetadata write verified by recovery service probe.`,
    )
    assert.deepEqual(patches[1].body, {
      tag_name: `v0.0.0-recovery-contract-${fake.nonce}`,
      draft: false,
    })
  })
for (const damage of [
  "id",
  "tag_name",
  "target_commitish",
  "name",
  "body",
  "draft",
  "immutable",
  "prerelease",
  "assets",
  "missing-inventory",
  "duplicate-inventory",
  "conflicting-nonce",
])
  test(`existing draft rejects ${damage} before mutation`, async () => {
    const fake = existingReleaseService()
    const api = fake.api
    fake.api = async (...args) => {
      const result = await api(...args),
        path = args[1]
      if (args[0] !== "GET") return result
      if (path.endsWith("/releases/100")) {
        result.body = structuredClone(result.body)
        if (["id", "tag_name", "target_commitish", "name", "body"].includes(damage))
          result.body[damage] = damage === "id" ? 99 : "wrong"
        if (["draft", "immutable", "prerelease"].includes(damage))
          result.body[damage] = !result.body[damage]
      }
      if (damage === "assets" && path.endsWith("/assets?per_page=100&page=1"))
        result.body = [{ id: 200 }]
      if (path.includes("/releases?")) {
        if (damage === "missing-inventory") result.body = []
        if (damage === "duplicate-inventory") result.body.push(result.body[0])
        if (damage === "conflicting-nonce") result.body.push({ ...result.body[0], id: 99 })
      }
      return result
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.deepEqual(fake.effects, [])
  })
for (const value of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1])
  test(`existing draft rejects invalid supplied ID ${value}`, async () => {
    const fake = existingReleaseService()
    fake.existingReleaseId = value
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.deepEqual(fake.calls, [])
  })
test("existing release requires existing tag mode before reads", async () => {
  const fake = existingReleaseService()
  delete fake.existingTagObjectSha
  await assert.rejects(subject.runPublicationServiceProbe(fake))
  assert.deepEqual(fake.calls, [])
})
for (const denied of ["metadata", "publication"])
  test(`existing draft stops at denied ${denied} PATCH without retry`, async () => {
    const fake = existingReleaseService()
    const api = fake.api
    fake.api = async (method, path, body) => {
      if (
        method === "PATCH" &&
        (denied === "metadata" ? body.draft === undefined : body.draft === false)
      ) {
        fake.effects.push({ method, path, body })
        return { status: 403, body: { message: "Resource not accessible by integration" } }
      }
      return api(method, path, body)
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(
      fake.effects.filter((e) => e.method === "PATCH").length,
      denied === "metadata" ? 1 : 2,
    )
  })

test("existing draft stops after unknown metadata response without upload or retry", async () => {
  const fake = existingReleaseService()
  const api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === "PATCH" && args[2].draft === undefined)
      throw Object.assign(new Error("unknown metadata response"), { uncertain: true })
    return result
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /unknown metadata/)
  assert.equal(fake.effects.length, 1)
  assert.equal(fake.effects[0].method, "PATCH")
})

test("existing draft verifies changed metadata body before upload", async () => {
  const fake = existingReleaseService()
  const api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === "GET" && args[1].endsWith("/releases/100") && fake.effects.length > 0)
      result.body = { ...result.body, body: "metadata mutation did not persist" }
    return result
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /draft identity/)
  assert.equal(fake.effects.length, 1)
  assert.equal(fake.effects[0].method, "PATCH")
})

function opaqueDraftService(options) {
  const fake = existingReleaseService(options),
    api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === "PATCH" && args[2].draft === undefined)
      result.body.tag_name = "untagged-e886bb9bf253e3ee7d74"
    return result
  }
  return fake
}
for (const uncertain of [null, "upload", "publish"])
  test(`metadata response may project a bounded opaque draft tag with ${uncertain ?? "known"} response`, async () => {
    const fake = opaqueDraftService({ uncertain })
    const result = await subject.runPublicationServiceProbe(fake)
    assert.equal(result.status, "published-immutable")
    assert.equal(result.observedDraftTag, "untagged-e886bb9bf253e3ee7d74")
    assert.deepEqual(fake.effects.at(-1).body, {
      tag_name: `v0.0.0-recovery-contract-${fake.nonce}`,
      draft: false,
    })
  })
for (const field of [
  "id",
  "body",
  "name",
  "target_commitish",
  "draft",
  "prerelease",
  "immutable",
  "tag_name",
])
  test(`metadata response must bind the owned draft ${field} before upload`, async () => {
    const fake = opaqueDraftService(),
      api = fake.api
    fake.api = async (...args) => {
      const result = await api(...args)
      if (args[0] === "PATCH" && args[2].draft === undefined)
        result.body = {
          ...result.body,
          [field]:
            typeof result.body[field] === "boolean"
              ? !result.body[field]
              : field === "id"
                ? 99
                : "wrong",
        }
      return result
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(fake.effects.length, 1)
  })
test("metadata projection requires exact response/readback agreement", async () => {
  const fake = opaqueDraftService(),
    api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === "GET" && args[1].endsWith("/releases/100") && fake.effects.length > 0)
      result.body = { ...result.body, tag_name: "untagged-00000000000000000000" }
    return result
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake))
  assert.equal(fake.effects.length, 1)
})
test("opaque draft projection is forbidden during initial preflight", async () => {
  const fake = existingReleaseService(),
    api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === "GET" && args[1].endsWith("/releases/100"))
      result.body = { ...result.body, tag_name: "untagged-e886bb9bf253e3ee7d74" }
    return result
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake))
  assert.deepEqual(fake.effects, [])
})
test("original annotated tag is independently checked again before publication", async () => {
  const fake = existingReleaseService(),
    api = fake.api
  fake.api = async (...args) => {
    const result = await api(...args)
    if (
      args[0] === "GET" &&
      args[1].includes("/git/ref/tags/") &&
      fake.effects.some((e) => e.path.includes("/assets?"))
    )
      result.body.object.sha = "d".repeat(40)
    return result
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake))
  assert.equal(
    fake.effects.some((e) => e.method === "PATCH" && e.body.draft === false),
    false,
  )
})

for (const tagName of [
  "untagged-fixture",
  `untagged-${"a".repeat(21)}`,
  [`untagged-${"a".repeat(20)}`],
])
  test(`metadata projection rejects unsupported tag representation ${JSON.stringify(tagName)}`, async () => {
    const fake = opaqueDraftService(),
      api = fake.api
    fake.api = async (...args) => {
      const result = await api(...args)
      if (args[0] === "PATCH" && args[2].draft === undefined) result.body.tag_name = tagName
      return result
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(fake.effects.length, 1)
  })
