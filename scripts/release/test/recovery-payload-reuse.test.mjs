import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { collectRecoveryEvidence } from "../recovery/evidence.mjs"
import { evidenceRemote } from "./support/recovery-evidence-fixture.mjs"

const module = await import("../recovery/payload-reuse.mjs").catch(() => ({}))
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex")
const bytes = Buffer.from("verified immutable bytes")
const binding = { assetId: "123", maximumBytes: bytes.length, sha256: hash(bytes) }
const encoded = bytes.toString("base64")
function fixture() {
  let calls = 0,
    time = 1000
  const dependencies = {
    fetchImpl: async () => {
      throw new Error("write transport must not be wrapped")
    },
    authority: { now: () => time },
    observation: {
      github: {
        async downloadReleaseAsset() {
          calls++
          return { status: "PRESENT", contentBase64: encoded }
        },
        async downloadActionsArtifact() {
          calls++
          return { status: "PRESENT", contentBase64: encoded }
        },
      },
      npm: {
        async downloadRegistryTarball(args) {
          calls++
          return {
            status: "PRESENT",
            tarball: {
              url: args.tarballUrl,
              size: bytes.length,
              contentBase64: encoded,
              sha1: hash(bytes, "sha1"),
              sha256: hash(bytes),
              sha512: hash(bytes, "sha512"),
            },
          }
        },
      },
    },
  }
  return {
    dependencies,
    calls: () => calls,
    setTime: (value) => {
      time = value
    },
  }
}
const run = (f, operation) => {
  assert.equal(typeof module.withRecoveryPayloadReuse, "function")
  return module.withRecoveryPayloadReuse(f.dependencies, operation)
}
test("one invocation reuses exact verified bytes and retains original writer identity", async () => {
  const f = fixture()
  let retained
  await run(f, async (d) => {
    assert.equal(d.fetchImpl, f.dependencies.fetchImpl)
    retained = d.observation.github
    const first = await retained.downloadReleaseAsset(binding)
    first.contentBase64 = "corrupted caller result"
    assert.equal((await retained.downloadReleaseAsset(binding)).contentBase64, encoded)
    assert.equal(f.calls(), 1)
  })
  await assert.rejects(retained.downloadReleaseAsset(binding), /closed/)
  await run(f, (d) => d.observation.github.downloadReleaseAsset(binding))
  assert.equal(f.calls(), 2)
})
test("fresh identity, digest and exact size are required on every lookup", async () => {
  const f = fixture()
  await run(f, async (d) => {
    const get = d.observation.github.downloadReleaseAsset
    await get(binding)
    await get({ ...binding, assetId: "124" })
    await get({ ...binding, sha256: "0".repeat(64) })
    await get({ ...binding, maximumBytes: bytes.length + 1 })
    await get({ assetId: binding.assetId, maximumBytes: bytes.length })
    assert.equal(f.calls(), 5)
  })
})
test("corrupt and unsuccessful payload responses never populate reuse", async () => {
  const f = fixture()
  let calls = 0
  f.dependencies.observation.github.downloadReleaseAsset = async () => {
    calls++
    return calls === 1 ? { status: "ERROR" } : { status: "PRESENT", contentBase64: "YQ==" }
  }
  await run(f, async (d) => {
    for (let i = 0; i < 3; i++) await d.observation.github.downloadReleaseAsset(binding)
    assert.equal(calls, 3)
  })
})
test("Actions archive reuse binds fresh expiry and rejects elapsed expiry", async () => {
  const f = fixture()
  const args = {
    artifactId: "456",
    maximumBytes: bytes.length,
    sha256: hash(bytes),
    expired: false,
    expiresAt: "1970-01-01T00:00:05.000Z",
  }
  await run(f, async (d) => {
    const get = d.observation.github.downloadActionsArtifact
    await get(args)
    await get(args)
    assert.equal(f.calls(), 1)
    await get({ ...args, expiresAt: "1970-01-01T00:00:06.000Z" })
    assert.equal(f.calls(), 2)
    await assert.rejects(get({ ...args, expired: true }), /expired/)
    f.setTime(5000)
    await assert.rejects(get(args), /expired/)
  })
})
test("npm reuse binds each fresh registry digest and reconstructs payload fields", async () => {
  const f = fixture()
  const args = {
    tarballUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
    maximumBytes: bytes.length,
    sha256: hash(bytes),
    sha512: hash(bytes, "sha512"),
    shasum: hash(bytes, "sha1"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  }
  await run(f, async (d) => {
    const get = d.observation.npm.downloadRegistryTarball
    assert.deepEqual(await get(args), await get(args))
    assert.equal(f.calls(), 1)
    await get({ ...args, shasum: "0".repeat(40) })
    assert.equal(f.calls(), 2)
  })
})
test("entry limit evicts old payloads", async () => {
  const f = fixture()
  await run(f, async (d) => {
    const get = d.observation.github.downloadReleaseAsset
    for (let i = 1; i <= 129; i++) await get({ ...binding, assetId: String(i) })
    await get({ ...binding, assetId: "1" })
    assert.equal(f.calls(), 130)
  })
})
test("deadline and closure reject late payload settlement and retained readers", async () => {
  const f = fixture()
  let settle, retained, pending
  f.dependencies.observation.github.downloadReleaseAsset = () =>
    new Promise((r) => {
      settle = r
    })
  await run(f, async (d) => {
    retained = d.observation.github
    pending = retained.downloadReleaseAsset(binding)
  })
  settle({ status: "PRESENT", contentBase64: encoded })
  await assert.rejects(pending, /closed/)
  await assert.rejects(retained.downloadReleaseAsset(binding), /closed/)
  await assert.rejects(
    run(f, async (d) => {
      f.setTime(1201000)
      await d.observation.github.downloadReleaseAsset(binding)
    }),
    /deadline/,
  )
})
test("complete 19-write evidence collection reuses payloads while refreshing inventory and batch audits", async () => {
  const r = await evidenceRemote()
  const counts = { release: 0, npm: 0, metadata: 0, actions: 0, factories: 0, audits: 0 }
  for (const [adapter, method, key] of [
    [r.args.github, "downloadReleaseAsset", "release"],
    [r.args.github, "downloadActionsArtifact", "actions"],
    [r.args.npm, "downloadRegistryTarball", "npm"],
    [r.args.npm, "observePackageVersion", "metadata"],
  ]) {
    const original = adapter[method]
    adapter[method] = async (...args) => {
      counts[key]++
      return original(...args)
    }
  }
  const create = r.args.npmAuditFactory.create
  r.args.npmAuditFactory.create = async () => {
    counts.factories++
    const actual = await create()
    return {
      ...actual,
      async verifyPackages(args) {
        counts.audits++
        return actual.verifyPackages(args)
      },
    }
  }
  const result = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
  assert.equal(counts.factories, 41)
  assert.equal(counts.audits, 41)
  assert.equal(counts.metadata, 861)
  assert.ok(counts.release < 150, JSON.stringify(counts))
  assert.equal(counts.npm, 21)
  assert.equal(counts.actions, 5)
  const releaseReads = counts.release
  const resumed = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  assert.equal(resumed.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
  assert.equal(counts.factories, 42)
  assert.equal(counts.audits, 42)
  assert.equal(counts.metadata, 882)
  assert.equal(counts.npm, 42)
  assert.ok(counts.release > releaseReads)
})
test("a working set between 64 and 128 MiB needs no downloads on its second pass", async () => {
  const f = fixture()
  const large = Buffer.alloc(10 * 1024 * 1024, 7)
  const contentBase64 = large.toString("base64")
  const assetIds = ["1", "2", "3"]
  const retainedBytes = assetIds.length * contentBase64.length * 2
  assert.ok(retainedBytes > 64 * 1024 * 1024 && retainedBytes < 128 * 1024 * 1024)
  const args = { ...binding, maximumBytes: large.length, sha256: hash(large) }
  let calls = 0
  f.dependencies.observation.github.downloadReleaseAsset = async () => {
    calls++
    return { status: "PRESENT", contentBase64 }
  }
  await run(f, async (d) => {
    for (const assetId of assetIds)
      await d.observation.github.downloadReleaseAsset({ ...args, assetId })
    assert.equal(calls, 3)
    for (const assetId of assetIds) {
      const result = await d.observation.github.downloadReleaseAsset({ ...args, assetId })
      assert.equal(result.contentBase64, contentBase64)
    }
    assert.equal(calls, 3)
  })
})
test("retained byte budget evicts payloads before the entry limit", async () => {
  const f = fixture()
  const large = Buffer.alloc(10 * 1024 * 1024, 7)
  const args = { ...binding, maximumBytes: large.length, sha256: hash(large) }
  let calls = 0
  f.dependencies.observation.github.downloadReleaseAsset = async () => {
    calls++
    return { status: "PRESENT", contentBase64: large.toString("base64") }
  }
  await run(f, async (d) => {
    for (const assetId of ["1", "2", "3", "4", "5", "1"])
      await d.observation.github.downloadReleaseAsset({ ...args, assetId })
    assert.equal(calls, 6)
  })
})
test("payload expiry that elapses during download rejects the late bytes", async () => {
  const f = fixture()
  f.dependencies.observation.github.downloadActionsArtifact = async () => {
    f.setTime(5000)
    return { status: "PRESENT", contentBase64: encoded }
  }
  await assert.rejects(
    run(f, (d) =>
      d.observation.github.downloadActionsArtifact({
        artifactId: "456",
        maximumBytes: bytes.length,
        sha256: hash(bytes),
        expired: false,
        expiresAt: "1970-01-01T00:00:05.000Z",
      }),
    ),
    /expired/,
  )
})
test("reuse checks the original deadline again after validating cached bytes", async () => {
  const f = fixture()
  let calls = 0,
    advance = false
  f.dependencies.authority.now = () => (advance && ++calls > 1 ? 1201000 : 1000)
  await run(f, async (d) => {
    await d.observation.github.downloadReleaseAsset(binding)
    advance = true
    await assert.rejects(d.observation.github.downloadReleaseAsset(binding), /deadline/)
  })
})
test("invalid initial clock cannot establish a reuse generation", async () => {
  const f = fixture()
  let first = true
  f.dependencies.authority.now = () => {
    if (first) {
      first = false
      return Number.NaN
    }
    return 1000
  }
  await assert.rejects(
    run(f, (d) => d.observation.github.downloadReleaseAsset(binding)),
    /clock/,
  )
})

const gitBinding = { ref: "a".repeat(40), path: "scripts/release/recovery/writer.mjs" }
function gitFixture(value = "immutable text") {
  const f = fixture()
  const reads = []
  f.dependencies.observation.git = {
    showFile: async (...args) => {
      reads.push(args)
      return value
    },
    resolveRef: async () => reads.push("resolve"),
    isAncestor: async () => reads.push("ancestry"),
  }
  return { ...f, reads }
}
test("immutable Git text is reused only inside one invocation; other Git reads stay fresh", async () => {
  const f = gitFixture()
  let retained
  await run(f, async (d) => {
    retained = d.observation.git
    assert.equal(await retained.showFile(gitBinding), "immutable text")
    assert.equal(await retained.showFile({ ...gitBinding }), "immutable text")
    assert.equal(f.reads.length, 1)
    for (let i = 0; i < 2; i++) {
      await retained.resolveRef("main")
      await retained.isAncestor(gitBinding.ref, gitBinding.ref)
    }
    assert.equal(f.reads.length, 5)
  })
  await assert.rejects(retained.showFile(gitBinding), /closed/)
  await run(f, (d) => d.observation.git.showFile(gitBinding))
  assert.equal(f.reads.length, 6)
})
test("Git memo bypasses mutable refs, options and nonplain or nondata request shapes unchanged", async () => {
  const f = gitFixture()
  const getter = { ...gitBinding }
  Object.defineProperty(getter, "ref", { get: () => gitBinding.ref, enumerable: true })
  const cases = [
    [{ ...gitBinding, ref: "main" }],
    [gitBinding, {}],
    [gitBinding, undefined],
    [{ ...gitBinding, extra: true }],
    [Object.assign(Object.create({ inherited: true }), gitBinding)],
    [new Proxy(gitBinding, {})],
    [getter],
    [{ ...gitBinding, [Symbol("extra")]: true }],
  ]
  await run(f, async (d) => {
    for (const args of cases) {
      await d.observation.git.showFile(...args)
      await d.observation.git.showFile(...args)
      assert.deepEqual(f.reads.at(-1), args)
    }
    assert.equal(f.reads.length, cases.length * 2)
  })
})
for (const value of [Buffer.from("not text"), "x".repeat(1024 * 1024 + 1)])
  test(`Git memo bypasses ${typeof value === "string" ? "oversized" : "nonstring"} results`, async () => {
    const f = gitFixture(value)
    await run(f, async (d) => {
      await d.observation.git.showFile(gitBinding)
      await d.observation.git.showFile(gitBinding)
      assert.equal(f.reads.length, 2)
    })
  })
for (const [name, value, count] of [
  ["entry", "text", 512],
  ["byte", "x".repeat(1024 * 1024), 8],
])
  test(`Git memo preserves its ${name} bound independently of payload retention`, async () => {
    const f = gitFixture(value)
    await run(f, async (d) => {
      for (let i = 0; i <= count; i++)
        await d.observation.git.showFile({ ...gitBinding, path: `file-${i}` })
      await d.observation.git.showFile({ ...gitBinding, path: "file-0" })
      assert.equal(f.reads.length, count + 1)
      await d.observation.git.showFile({ ...gitBinding, path: `file-${count}` })
      assert.equal(f.reads.length, count + 2)
      await d.observation.github.downloadReleaseAsset(binding)
      await d.observation.github.downloadReleaseAsset(binding)
      assert.equal(f.calls(), 1)
    })
  })
test("Git memo never retains rejected reads", async () => {
  const f = gitFixture()
  let calls = 0
  f.dependencies.observation.git.showFile = async () => {
    if (++calls === 1) throw new Error("unavailable")
    return "text"
  }
  await run(f, async (d) => {
    await assert.rejects(d.observation.git.showFile(gitBinding), /unavailable/)
    assert.equal(await d.observation.git.showFile(gitBinding), "text")
    assert.equal(await d.observation.git.showFile(gitBinding), "text")
    assert.equal(calls, 2)
  })
})
test("Git memo checks deadlines both before and after cache hits", async () => {
  const f = gitFixture()
  let advance = false,
    checks = 0
  f.dependencies.authority.now = () => (advance && ++checks > 1 ? 1201000 : 1000)
  await run(f, async (d) => {
    await d.observation.git.showFile(gitBinding)
    advance = true
    await assert.rejects(d.observation.git.showFile(gitBinding), /deadline/)
    await assert.rejects(d.observation.git.showFile(gitBinding), /closed/)
    assert.equal(f.reads.length, 1)
  })
})
test("Git memo rejects late completion after scope settlement", async () => {
  const f = gitFixture()
  let finish, pending
  f.dependencies.observation.git.showFile = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  await run(f, (d) => {
    pending = d.observation.git.showFile(gitBinding)
  })
  const rejected = assert.rejects(pending, /closed/)
  finish("late text")
  await rejected
})
test("Git memo rejects a download finishing after the original deadline", async () => {
  const f = gitFixture()
  f.dependencies.observation.git.showFile = async () => {
    f.setTime(1201000)
    return "late text"
  }
  await assert.rejects(
    run(f, (d) => d.observation.git.showFile(gitBinding)),
    /deadline/,
  )
})
test("Git memo does not share pending reads or mix different immutable keys", async () => {
  const f = gitFixture()
  let calls = 0
  const finishes = []
  f.dependencies.observation.git.showFile = () => {
    calls++
    return new Promise((resolve) => finishes.push(resolve))
  }
  await run(f, async (d) => {
    const first = d.observation.git.showFile(gitBinding)
    const second = d.observation.git.showFile(gitBinding)
    assert.equal(calls, 2)
    for (const finish of finishes) finish("text")
    await Promise.all([first, second])
    assert.equal(await d.observation.git.showFile(gitBinding), "text")
    const different = d.observation.git.showFile({ ...gitBinding, ref: "b".repeat(40) })
    assert.equal(calls, 3)
    finishes.at(-1)("other text")
    assert.equal(await different, "other text")
  })
})
